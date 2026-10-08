import { fstatSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  CanaryOperation,
  canaryResourceLabels,
  canaryResourceName,
} from "../../../../packages/protocol/src/canary-operation.ts";
import {
  type CanaryOperationContext,
  type CanaryOperationJournal,
  canaryOperationStore,
  recoverCanaryOperation,
  withCanaryOperation,
} from "./canary-operation.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const signal = () => new AbortController().signal;
const input = {
  owner: "a".repeat(32),
  engineId: "engine-fixture",
  cellId: "01JXYZ00000000000000000001",
  images: {
    desktop: {
      ref: `registry.invalid/desktop@sha256:${"b".repeat(64)}`,
      id: `sha256:${"c".repeat(64)}`,
    },
    gate: { ref: `registry.invalid/gate@sha256:${"d".repeat(64)}`, id: `sha256:${"e".repeat(64)}` },
  },
};
async function fixture() {
  const state = await realpath(await mkdtemp(join(tmpdir(), "localdot-canary-operation-")));
  roots.push(state);
  await chmod(state, 0o700);
  const context: CanaryOperationContext = {
    state,
    store: canaryOperationStore(state),
    acquire: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
  };
  return context;
}
async function stranded(context: CanaryOperationContext) {
  const cleanup = context.cleanup;
  context.cleanup = vi.fn(async () => {
    throw new Error("cleanup uncertain");
  });
  await expect(withCanaryOperation(context, input, signal(), async () => {})).rejects.toThrow(
    "cleanup uncertain",
  );
  context.cleanup = cleanup;
  const record = await context.store.read();
  if (!record) throw new Error("missing fixture record");
  return { record, directory: join(context.state, `canary-${record.runId}`) };
}

it("persists intent before effects, serializes resource captures and retires before removing artifacts", async () => {
  const context = await fixture(),
    store = context.store,
    events: string[] = [];
  context.store = {
    read: store.read,
    save: async (value) => {
      events.push(value?.phase ?? "cleared");
      if (value?.phase === "allocating") expect(await readdir(context.state)).toEqual([]);
      if (value?.phase === "retired")
        expect(await readdir(join(context.state, `canary-${value.runId}`))).toEqual(["artifact"]);
      await store.save(value);
    },
  };
  let descriptor = -1;
  context.acquire = vi.fn(async (fd) => {
    descriptor = fd;
    expect((await store.read())?.phase).toBe("active");
    events.push("acquired");
  });
  context.cleanup = vi.fn(async (record) => {
    expect(fstatSync(descriptor).isDirectory()).toBe(true);
    expect(record.resources).toEqual({
      desktop: "1".repeat(64),
      gate: "2".repeat(64),
      internal: null,
      egress: null,
      home: true,
    });
    events.push("cleanup");
  });
  const value = await withCanaryOperation(
    context,
    input,
    signal(),
    async (journal, directory, fd) => {
      expect(fd).toBe(descriptor);
      expect(await readdir(directory)).toEqual([]);
      const snapshot = journal.snapshot();
      expect(canaryResourceName(snapshot.runId, "desktop")).toBe(
        `localdot-canary-${snapshot.runId.replaceAll("-", "")}-desktop`,
      );
      expect(canaryResourceLabels(snapshot, "desktop")).toEqual({
        "localdot.install-owner": input.owner,
        "localdot.canary-run": snapshot.runId,
        "localdot.cell": input.cellId,
        "localdot.role": "desktop",
      });
      snapshot.engineId = "untrusted-mutated-snapshot";
      expect(journal.snapshot().engineId).toBe(input.engineId);
      await Promise.all([
        journal.capture("desktop", "1".repeat(64)),
        journal.capture("gate", "2".repeat(64)),
        journal.capture("home", true),
      ]);
      await writeFile(join(directory, "artifact"), "synthetic artifact", { mode: 0o600 });
      return "verified";
    },
  );
  expect(value).toBe("verified");
  expect(events).toEqual([
    "allocating",
    "active",
    "acquired",
    "active",
    "active",
    "active",
    "cleanup",
    "retired",
    "cleared",
  ]);
  expect(await store.read()).toBeNull();
  expect(await readdir(context.state)).toEqual(["canary-operation.json"]);
  expect(() => fstatSync(descriptor)).toThrow();
});

it("runs cleanup with an independent signal after caller cancellation and work drainage", async () => {
  const context = await fixture(),
    controller = new AbortController(),
    events: string[] = [];
  context.cleanup = vi.fn(async (_r, _p, cleanupSignal) => {
    expect(cleanupSignal.aborted).toBe(false);
    events.push("cleanup");
  });
  await expect(
    withCanaryOperation(context, input, controller.signal, async () => {
      controller.abort();
      await Promise.resolve();
      events.push("drained");
      throw new Error("cancelled work");
    }),
  ).rejects.toThrow("cancelled work");
  expect(events).toEqual(["drained", "cleanup"]);
  expect(await context.store.read()).toBeNull();
});

it.each(["before", "after"])(
  "retains a %s-write capture failure as failure even if work catches it",
  async (when) => {
    const context = await fixture(),
      store = context.store;
    let failed = false;
    context.store = {
      read: store.read,
      save: async (value) => {
        if (!failed && value?.phase === "active" && value.resources.desktop !== null) {
          failed = true;
          if (when === "after") await store.save(value);
          throw new Error("write uncertain");
        }
        await store.save(value);
      },
    };
    context.cleanup = vi.fn(async (r) => {
      expect(r.resources.desktop).toBe(when === "after" ? "1".repeat(64) : null);
    });
    await expect(
      withCanaryOperation(context, input, signal(), async (journal) => {
        await journal.capture("desktop", "1".repeat(64)).catch(() => {});
        await expect(journal.capture("gate", "2".repeat(64))).rejects.toThrow();
        return "must not pass";
      }),
    ).rejects.toThrow();
    expect(context.cleanup).toHaveBeenCalledOnce();
    expect(await store.read()).toBeNull();
  },
);

it("never rebinds a captured full ID", async () => {
  const context = await fixture();
  await expect(
    withCanaryOperation(context, input, signal(), async (journal) => {
      await journal.capture("desktop", "1".repeat(64));
      await journal.capture("desktop", "2".repeat(64));
    }),
  ).rejects.toThrow();
  expect(context.cleanup).toHaveBeenCalledWith(
    expect.objectContaining({ resources: expect.objectContaining({ desktop: "1".repeat(64) }) }),
    expect.any(String),
    expect.any(AbortSignal),
  );
});

it("seals the journal before retirement so late captures cannot recreate an active record", async () => {
  const context = await fixture();
  let retained: CanaryOperationJournal | undefined;
  await withCanaryOperation(context, input, signal(), async (journal) => {
    retained = journal;
  });
  await expect(retained?.capture("desktop", "1".repeat(64))).rejects.toThrow();
  expect(await context.store.read()).toBeNull();
});

it("cannot return success when work ignores caller cancellation", async () => {
  const context = await fixture(),
    controller = new AbortController();
  await expect(
    withCanaryOperation(context, input, controller.signal, async () => {
      controller.abort();
      return "ignored";
    }),
  ).rejects.toThrow();
  expect(await context.store.read()).toBeNull();
});

it("retains an unfinished run and refuses new work until recovery acquires its lease", async () => {
  const context = await fixture(),
    { record, directory } = await stranded(context),
    work = vi.fn();
  await expect(withCanaryOperation(context, input, signal(), work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  context.acquire = vi.fn(async () => {
    throw new Error("helper still alive");
  });
  await expect(recoverCanaryOperation(context, input, signal())).rejects.toThrow(
    "helper still alive",
  );
  expect(context.cleanup).not.toHaveBeenCalled();
  expect(await context.store.read()).toEqual(record);
  expect((await lstat(directory)).isDirectory()).toBe(true);
  context.acquire = vi.fn(async () => {});
  await recoverCanaryOperation(context, input, signal());
  expect(context.cleanup).toHaveBeenCalledOnce();
  expect(await context.store.read()).toBeNull();
  await expect(lstat(directory)).rejects.toThrow();
});

it.each(["owner", "engine", "missing", "replaced", "symlink", "public"])(
  "refuses %s recovery without cleanup",
  async (fault) => {
    const context = await fixture(),
      { record, directory } = await stranded(context);
    const expected = { ...input };
    if (fault === "owner") expected.owner = "f".repeat(32);
    if (fault === "engine") expected.engineId = "other-engine";
    if (fault === "missing") await rm(directory, { recursive: true });
    if (fault === "replaced" || fault === "symlink") {
      await rename(directory, `${directory}-original`);
      if (fault === "replaced") await mkdir(directory, { mode: 0o700 });
      else await symlink(`${directory}-original`, directory);
    }
    if (fault === "public") await chmod(directory, 0o755);
    await expect(recoverCanaryOperation(context, expected, signal())).rejects.toThrow();
    expect(context.cleanup).not.toHaveBeenCalled();
    expect(await context.store.read()).toEqual(record);
  },
);

it.each(["absent", "empty", "nonempty"])(
  "recovers an allocation interruption with %s directory",
  async (kind) => {
    const context = await fixture(),
      store = context.store,
      work = vi.fn();
    context.store = {
      read: store.read,
      save: async (r) => {
        await store.save(r);
        if (r?.phase === "allocating") throw new Error("lost intent acknowledgement");
      },
    };
    await expect(withCanaryOperation(context, input, signal(), work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    context.store = store;
    const record = await store.read();
    if (!record) throw new Error("missing intent");
    const directory = join(context.state, `canary-${record.runId}`);
    if (kind !== "absent") await mkdir(directory, { mode: 0o700 });
    if (kind === "nonempty") await writeFile(join(directory, "unexpected"), "retain");
    if (kind === "nonempty") {
      await expect(recoverCanaryOperation(context, input, signal())).rejects.toThrow();
      expect(await store.read()).toEqual(record);
      expect(context.cleanup).not.toHaveBeenCalled();
    } else {
      await recoverCanaryOperation(context, input, signal());
      expect(await store.read()).toBeNull();
      expect(context.cleanup).toHaveBeenCalledTimes(kind === "empty" ? 1 : 0);
    }
  },
);

it.each(["retired-write", "clear-write"])("recovers a lost %s acknowledgement", async (fault) => {
  const context = await fixture(),
    store = context.store;
  let injected = false,
    directory = "";
  context.store = {
    read: store.read,
    save: async (r) => {
      if (!injected && (fault === "retired-write" ? r?.phase === "retired" : r === null)) {
        injected = true;
        if (fault === "retired-write") await store.save(r);
        throw new Error("lost persistence acknowledgement");
      }
      await store.save(r);
    },
  };
  await expect(
    withCanaryOperation(context, input, signal(), async (_j, path) => {
      directory = path;
    }),
  ).rejects.toThrow();
  expect((await store.read())?.phase).toBe("retired");
  if (fault === "clear-write") await expect(lstat(directory)).rejects.toThrow();
  else expect((await lstat(directory)).isDirectory()).toBe(true);
  context.store = store;
  await recoverCanaryOperation(context, input, signal());
  expect(await store.read()).toBeNull();
  expect(context.cleanup).toHaveBeenCalledTimes(2);
});

it("removes symlink artifacts without following their targets", async () => {
  const context = await fixture(),
    external = join(context.state, "keep");
  await writeFile(external, "keep", { mode: 0o600 });
  await withCanaryOperation(context, input, signal(), async (_j, directory) => {
    await symlink(external, join(directory, "link"));
  });
  expect(await readFile(external, "utf8")).toBe("keep");
});

it.each(["extra-secret", "pid", "invalid-image", "short-id", "allocating-with-effects"])(
  "refuses a %s journal",
  async (fault) => {
    const context = await fixture(),
      { record } = await stranded(context);
    const bad: Record<string, unknown> = structuredClone(record);
    if (fault === "extra-secret") bad.token = "private";
    if (fault === "pid") bad.pid = 123;
    if (fault === "invalid-image")
      bad.images = { ...input.images, desktop: { id: "latest", ref: "latest" } };
    if (fault === "short-id") bad.resources = { ...record.resources, desktop: "abcd" };
    if (fault === "allocating-with-effects") {
      bad.phase = "allocating";
      bad.directory = null;
      bad.resources = { ...record.resources, home: true };
    }
    expect(CanaryOperation.safeParse(bad).success).toBe(false);
    await writeFile(join(context.state, "canary-operation.json"), JSON.stringify(bad), {
      mode: 0o600,
    });
    await expect(recoverCanaryOperation(context, input, signal())).rejects.toThrow();
    expect(context.cleanup).not.toHaveBeenCalled();
  },
);
