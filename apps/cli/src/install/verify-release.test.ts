import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TufVersions } from "../../../../packages/protocol/src/install-update.ts";
import { privateRecordStore } from "./private-record.ts";

const host = vi.hoisted(() => vi.fn());
vi.mock("./verification-worker-host.ts", () => ({ runVerificationWorker: host }));

import { previewReleaseTrust, verifyReleaseWithFreshTrust } from "./verify-release.ts";

const artifact = {
  name: "localdot" as const,
  version: "1.2.3",
  sha512: "a".repeat(128),
  commit: "b".repeat(40),
};
const versions = TufVersions.parse(
  Object.fromEntries(
    ["root", "timestamp", "snapshot", "targets"].map((role) => [
      role,
      { version: 1, sha256: "c".repeat(64) },
    ]),
  ),
);
const dirs: string[] = [];
async function home() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "localdot-trust-commit-")));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  host.mockReset();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("commits only a successful worker result and removes its private scratch storage", async () => {
  const dir = await home();
  host.mockImplementation(async (url, data) => {
    expect(url.pathname.endsWith("/release-verification-worker.ts")).toBe(true);
    expect(data.previous).toBe(null);
    expect(data.artifact).toEqual(artifact);
    expect((await lstat(data.directory)).mode & 0o777).toBe(0o700);
    await writeFile(join(data.directory, "worker-owned-data"), "fixture");
    return versions;
  });
  await verifyReleaseWithFreshTrust(dir, "{}", artifact, new AbortController().signal);
  expect(await privateRecordStore(dir, "trust-versions.json", TufVersions).read()).toEqual(
    versions,
  );
  expect(await readdir(dir)).toEqual(["trust-versions.json"]);
});
it("preserves existing floors and cleans scratch after verification failure or cancellation", async () => {
  for (const cancel of [false, true]) {
    const dir = await home();
    const store = privateRecordStore(dir, "trust-versions.json", TufVersions);
    await store.save(versions);
    const controller = new AbortController();
    const reason = new Error("verification stopped");
    host.mockImplementation(async (_url, data) => {
      expect(data.previous).toEqual(versions);
      await writeFile(join(data.directory, "worker-owned-data"), "fixture");
      if (cancel) controller.abort(reason);
      throw reason;
    });
    await expect(verifyReleaseWithFreshTrust(dir, "{}", artifact, controller.signal)).rejects.toBe(
      reason,
    );
    expect(await store.read()).toEqual(versions);
    expect(await readdir(dir)).toEqual(["trust-versions.json"]);
  }
});
it("keeps durable trust floors in state when worker scratch is inside recorded assembly", async () => {
  const state = await home(),
    scratch = join(state, "assembly");
  await mkdir(scratch, { mode: 0o700 });
  const store = privateRecordStore(state, "trust-versions.json", TufVersions);
  await store.save(versions);
  host.mockImplementation(async (_entry, data) => {
    expect(data.directory.startsWith(`${scratch}/.verify-`)).toBe(true);
    expect(data.previous).toEqual(versions);
    await writeFile(join(data.directory, "partial"), "cache");
    return versions;
  });
  await verifyReleaseWithFreshTrust(state, "{}", artifact, new AbortController().signal, scratch);
  expect(await store.read()).toEqual(versions);
  expect(await readdir(scratch)).toEqual([]);
  expect((await readdir(state)).sort()).toEqual(["assembly", "trust-versions.json"]);
});
it("independently rejects a worker result that rolls the persisted trust state backwards", async () => {
  const dir = await home();
  const store = privateRecordStore(dir, "trust-versions.json", TufVersions);
  const newer = structuredClone(versions);
  newer.timestamp.version = 2;
  await store.save(newer);
  host.mockResolvedValue(versions);
  await expect(
    verifyReleaseWithFreshTrust(dir, "{}", artifact, new AbortController().signal),
  ).rejects.toThrow("went backwards");
  expect(await store.read()).toEqual(newer);
  expect(await readdir(dir)).toEqual(["trust-versions.json"]);
});
it("refuses invalid requests and pre-cancelled calls before starting a worker or creating state", async () => {
  const dir = await home();
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);
  await expect(verifyReleaseWithFreshTrust(dir, "{}", artifact, controller.signal)).rejects.toBe(
    reason,
  );
  await expect(
    verifyReleaseWithFreshTrust(
      dir,
      "x".repeat(2 * 1024 * 1024 + 1),
      artifact,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Invalid release");
  expect(host).not.toHaveBeenCalled();
  expect(await readdir(dir)).toEqual([]);
});

it("previews fresh trust without writing or advancing durable floors", async () => {
  const dir = await home(),
    store = privateRecordStore(dir, "trust-versions.json", TufVersions);
  await store.save(versions);
  const newer = structuredClone(versions);
  newer.timestamp.version = 2;
  host.mockResolvedValue(newer);
  expect(
    await previewReleaseTrust(dir, versions, "{}", artifact, new AbortController().signal),
  ).toEqual(newer);
  expect(await store.read()).toEqual(versions);
  expect(await readdir(dir)).toEqual(["trust-versions.json"]);
});
it.each(["advance", "equivocate", "delete"])(
  "rereads durable trust before committing after concurrent %s",
  async (kind) => {
    const dir = await home(),
      store = privateRecordStore(dir, "trust-versions.json", TufVersions);
    await store.save(versions);
    const current = structuredClone(versions);
    if (kind === "advance") current.timestamp.version = 2;
    if (kind === "equivocate") current.timestamp.sha256 = "d".repeat(64);
    host.mockImplementation(async () => {
      if (kind === "delete") await rm(join(dir, "trust-versions.json"));
      else await store.save(current);
      return versions;
    });
    await expect(
      verifyReleaseWithFreshTrust(dir, "{}", artifact, new AbortController().signal),
    ).rejects.toThrow();
    expect(await store.read()).toEqual(kind === "delete" ? null : current);
  },
);
