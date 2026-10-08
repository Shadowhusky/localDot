import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withAcquiredNativeArchives } from "./acquire-native.ts";
import { nativeDependencyPlan } from "./native-plan.ts";
import { MAX_NATIVE_ARCHIVE_BYTES, type NativeArchiveDownload } from "./registry-download.ts";
import { nativeFixture } from "./testing/native-fixture.ts";

const roots: string[] = [];
const body = Buffer.from("pinned archive bytes");
const signal = () => new AbortController().signal;
function plan() {
  const f = nativeFixture();
  for (const [name, pkg] of Object.entries(f.lock.packages))
    if (name) pkg.integrity = `sha512-${createHash("sha512").update(body).digest("base64")}`;
  return nativeDependencyPlan(JSON.stringify(f.pkg), JSON.stringify(f.lock), "1.0.0");
}
async function root() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "localdot-native-download-")));
  roots.push(dir);
  await writeFile(join(dir, "keep"), "preserve");
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.useRealTimers();
});
const download: NativeArchiveDownload = async function* () {
  yield body.subarray(0, 3);
  yield body.subarray(3);
};
it("downloads all pinned bytes sequentially, seals files and cleans after consumer completion", async () => {
  const dir = await root();
  const names: string[] = [];
  let active = false;
  const tracked: NativeArchiveDownload = async function* (pkg) {
    expect(active).toBe(false);
    active = true;
    names.push(pkg.name);
    try {
      yield body;
    } finally {
      active = false;
    }
  };
  const result = await withAcquiredNativeArchives(
    dir,
    plan(),
    signal(),
    async (archives) => {
      expect(Object.isFrozen(archives)).toBe(true);
      expect(Object.keys(archives)).toHaveLength(6);
      for (const path of Object.values(archives)) {
        expect(await readFile(path)).toEqual(body);
        const st = await lstat(path);
        expect(st.mode & 0o7777).toBe(0o400);
        expect(st.nlink).toBe(1);
      }
      return "prepared";
    },
    tracked,
  );
  expect(result).toBe("prepared");
  expect(names).toEqual(plan().map((pkg) => pkg.name));
  expect(await readdir(dir)).toEqual(["keep"]);
});
it.each(["wrong-hash", "empty", "oversize", "partial-error", "non-buffer"])(
  "refuses %s and drains the source before cleanup",
  async (kind) => {
    const dir = await root(),
      work = vi.fn();
    let closed = false;
    const broken: NativeArchiveDownload = async function* () {
      try {
        if (kind === "wrong-hash") yield Buffer.from("corrupt");
        if (kind === "oversize") yield Buffer.alloc(MAX_NATIVE_ARCHIVE_BYTES + 1);
        if (kind === "non-buffer") yield "bad" as unknown as Buffer;
        if (kind === "partial-error") {
          yield body.subarray(0, 3);
          throw new Error("connection closed");
        }
      } finally {
        closed = true;
      }
    };
    await expect(withAcquiredNativeArchives(dir, plan(), signal(), work, broken)).rejects.toThrow(
      "download failed",
    );
    expect(closed).toBe(true);
    expect(work).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(["keep"]);
  },
);
it.each(["url", "hash", "integrity", "duplicate", "empty-plan", "oversize-plan"])(
  "refuses invalid %s before making a request",
  async (kind) => {
    const dir = await root(),
      entries = plan().map((p) => ({ ...p })),
      spy = vi.fn(download);
    const first = entries[0];
    if (!first) throw new Error("fixture");
    if (kind === "url") first.resolved = "https://elsewhere.invalid/archive";
    if (kind === "hash") first.sha512 = "0".repeat(128);
    if (kind === "integrity") first.integrity = "sha512-invalid";
    if (kind === "duplicate") entries.push(first);
    if (kind === "empty-plan") entries.length = 0;
    if (kind === "oversize-plan") while (entries.length < 129) entries.push(first);
    await expect(
      withAcquiredNativeArchives(dir, entries, signal(), vi.fn(), spy),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(["keep"]);
  },
);
it("snapshots authority before awaits instead of following caller mutation", async () => {
  const dir = await root(),
    entries = plan().map((p) => ({ ...p }));
  const run = withAcquiredNativeArchives(
    dir,
    entries,
    signal(),
    async (files) => Object.keys(files),
    download,
  );
  for (const pkg of entries) {
    pkg.resolved = "https://elsewhere.invalid";
    pkg.name = "changed";
    pkg.sha512 = "0".repeat(128);
  }
  entries.length = 0;
  expect(await run).toEqual(plan().map((pkg) => pkg.name));
});
it("preserves cancellation and waits for iterator cleanup before removing partial files", async () => {
  const dir = await root(),
    controller = new AbortController(),
    reason = new Error("stop");
  let release!: () => void, entered!: () => void;
  const cleanup = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const blocked: NativeArchiveDownload = async function* (_pkg, active) {
    try {
      yield body.subarray(0, 3);
      await new Promise<void>((resolve) => {
        active.addEventListener("abort", () => resolve(), { once: true });
        entered();
      });
      active.throwIfAborted();
    } finally {
      await cleanup;
    }
  };
  let settled = false;
  const run = withAcquiredNativeArchives(dir, plan(), controller.signal, vi.fn(), blocked).catch(
    (e) => {
      settled = true;
      return e;
    },
  );
  await started;
  controller.abort(reason);
  await new Promise((r) => setImmediate(r));
  expect(settled).toBe(false);
  expect((await readdir(dir)).some((name) => name.startsWith(".native-download-"))).toBe(true);
  release();
  expect(await run).toBe(reason);
  expect(await readdir(dir)).toEqual(["keep"]);
});
it("cleans callback failure and refuses unsafe parents or pre-aborted work", async () => {
  const dir = await root();
  await expect(
    withAcquiredNativeArchives(
      dir,
      plan(),
      signal(),
      async () => {
        throw new Error("health failed");
      },
      download,
    ),
  ).rejects.toThrow();
  expect(await readdir(dir)).toEqual(["keep"]);
  const spy = vi.fn(download);
  await chmod(dir, 0o755);
  await expect(withAcquiredNativeArchives(dir, plan(), signal(), vi.fn(), spy)).rejects.toThrow();
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await expect(
    withAcquiredNativeArchives(dir, plan(), controller.signal, vi.fn(), spy),
  ).rejects.toThrow("stop");
  expect(spy).not.toHaveBeenCalled();
});
it("enforces the overall deadline through a cooperative callback", async () => {
  const dir = await root();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const run = withAcquiredNativeArchives(
    dir,
    plan(),
    signal(),
    async (_files, active) => {
      entered();
      await new Promise<void>((r) => active.addEventListener("abort", () => r(), { once: true }));
      active.throwIfAborted();
    },
    download,
  ).catch((e) => e);
  await started;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(await run).toBeInstanceOf(Error);
  expect(vi.getTimerCount()).toBe(0);
  expect(await readdir(dir)).toEqual(["keep"]);
});
