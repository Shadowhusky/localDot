import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { keydLockAcquirer, withInstallLock } from "./install-lock.ts";
import { releaseDirectoryName, releaseLayout } from "./release-layout.ts";
import { buildTestKeyd } from "./testing/keyd-fixture.ts";
import { updateJournalStore } from "./update-journal.ts";
import { activateUpdate, type ReleaseIdentity, recoverUpdate } from "./update-transaction.ts";

const roots: string[] = [];
const old: ReleaseIdentity = {
  version: "1.0.0",
  packageSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
};
const next: ReleaseIdentity = {
  version: "1.1.0",
  packageSha256: "c".repeat(64),
  manifestSha256: "d".repeat(64),
};
let binary: Awaited<ReturnType<typeof buildTestKeyd>> | undefined;
let helper: ReturnType<typeof keydLockAcquirer>;
beforeAll(async () => {
  binary = await buildTestKeyd();
  helper = keydLockAcquirer(binary.path);
}, 65_000);
afterAll(() => binary?.dispose());
const signal = () => new AbortController().signal;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-layout-")));
  roots.push(root);
  await chmod(root, 0o700);
  for (const identity of [old, next])
    await mkdir(join(root, "releases", releaseDirectoryName(identity)), {
      recursive: true,
      mode: 0o700,
    });
  return root;
}
it("uses a bounded digest identity rather than paths or a version-only directory", async () => {
  expect(releaseDirectoryName(old)).toBe(`${old.packageSha256}-${old.manifestSha256}`);
  expect(() => releaseDirectoryName({ ...old, version: "../escape" })).toThrow();
  expect(() => releaseDirectoryName({ ...old, packageSha256: "../escape" })).toThrow();
  expect(() => releaseDirectoryName({ ...old, path: "/foreign" } as ReleaseIdentity)).toThrow();
});
it("selects only after verification and clears the selection without deleting a release", async () => {
  const root = await fixture();
  const verified: string[] = [];
  const layout = releaseLayout(root, async (path) => {
    verified.push(path);
  });
  expect(await layout.current()).toBeNull();
  await layout.select(old, signal());
  expect(verified).toEqual([await layout.path(old)]);
  expect(await releaseLayout(root, async () => {}).current()).toEqual(old);
  await layout.select(null, signal());
  expect(await layout.current()).toBeNull();
  expect(await layout.path(old)).toBe(join(root, "releases", releaseDirectoryName(old)));
});
it("keeps the previous selection after failed verification or cancellation", async () => {
  const root = await fixture();
  const layout = releaseLayout(root, async () => {});
  await layout.select(old, signal());
  await expect(
    releaseLayout(root, async () => {
      throw new Error("untrusted");
    }).select(next, signal()),
  ).rejects.toThrow("untrusted");
  expect(await layout.current()).toEqual(old);
  const controller = new AbortController();
  await expect(
    releaseLayout(root, async () => {
      controller.abort();
    }).select(next, controller.signal),
  ).rejects.toThrow();
  expect(await layout.current()).toEqual(old);
});
it.each(["root-link", "releases-link", "leaf-link", "leaf-mode", "missing"])(
  "refuses %s release layout without changing the pointer",
  async (kind) => {
    const root = await fixture();
    const layout = releaseLayout(root, async () => {});
    await layout.select(old, signal());
    const leaf = await layout.path(next);
    if (kind === "missing") await rm(leaf, { recursive: true });
    if (kind === "leaf-mode") await chmod(leaf, 0o777);
    if (kind === "leaf-link") {
      await rm(leaf, { recursive: true });
      await symlink(await layout.path(old), leaf);
    }
    if (kind === "releases-link") {
      await rename(join(root, "releases"), join(root, "other"));
      await symlink(join(root, "other"), join(root, "releases"));
    }
    let target = layout;
    if (kind === "root-link") {
      const alias = join(root, "alias");
      await symlink(root, alias);
      target = releaseLayout(alias, async () => {});
    }
    await expect(target.select(next, signal())).rejects.toThrow();
    expect(JSON.parse(await readFile(join(root, "selected.json"), "utf8"))).toEqual(old);
  },
);
it("rejects a leaf replacement that occurs during verification", async () => {
  const root = await fixture();
  const layout = releaseLayout(root, async (path) => {
    await rename(path, `${path}-replaced`);
    await mkdir(path, { mode: 0o700 });
  });
  await expect(layout.select(next, signal())).rejects.toThrow("changed");
  expect(await layout.current()).toBeNull();
});
it("rejects a malformed selected record rather than following an arbitrary path", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "selected.json"),
    JSON.stringify({ ...old, executable: "/arbitrary" }),
    { mode: 0o600 },
  );
  await expect(releaseLayout(root, async () => {}).current()).rejects.toThrow("unsafe");
});
it("composes real mutex, journal and pointer storage through a failed activation and restart", async () => {
  const root = await fixture(),
    events: string[] = [];
  const verify = async (_path: string, identity: ReleaseIdentity) => {
    events.push(`verify:${identity.version}`);
  };
  const layout = releaseLayout(root, verify);
  const host = {
    ...updateJournalStore(root),
    ...layout,
    async verify(identity: ReleaseIdentity, s: AbortSignal) {
      s.throwIfAborted();
      await verify(await layout.path(identity), identity);
    },
    async quiesce() {
      events.push("quiesce");
    },
    async start(identity: ReleaseIdentity) {
      events.push(`start:${identity.version}`);
    },
    async healthy(identity: ReleaseIdentity) {
      if (identity.version === next.version) throw new Error("candidate unhealthy");
      events.push("old healthy");
    },
  };
  await withInstallLock(root, signal(), helper, async () => {
    await layout.select(old, signal());
  });
  await expect(
    withInstallLock(root, signal(), helper, async () => activateUpdate(host, next, signal())),
  ).rejects.toThrow("restored");
  expect(await layout.current()).toEqual(old);
  expect((await updateJournalStore(root).read())?.phase).toBe("rolled-back");
  const reopened = { ...host, ...updateJournalStore(root), ...releaseLayout(root, verify) };
  await withInstallLock(root, signal(), helper, async () => {
    expect((await recoverUpdate(reopened))?.phase).toBe("rolled-back");
  });
  expect(events).toContain("start:1.1.0");
  expect(events).toContain("old healthy");
  expect(await layout.path(next)).toBeTruthy(); // Rollback preserves staged payloads and all data.
});
