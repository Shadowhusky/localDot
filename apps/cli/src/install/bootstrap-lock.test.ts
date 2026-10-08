import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { TufVersions } from "../../../../packages/protocol/src/install-update.ts";
import { KEYD_PACKAGE } from "../../../../packages/protocol/src/release.ts";
import { withBootstrapInstallLock } from "./bootstrap-lock.ts";
import { keydLockAcquirer, withInstallLock } from "./install-lock.ts";
import { privateRecordStore } from "./private-record.ts";
import { registryResourceURL } from "./registry-download.ts";
import { RELEASE_PROVENANCE_PINS } from "./release-trust.ts";
import { buildTestKeyd } from "./testing/keyd-fixture.ts";
import { tarBytes } from "./testing/tar-fixture.ts";

const mocks = vi.hoisted(() => ({ download: vi.fn(), worker: vi.fn(), signature: vi.fn() }));
vi.mock("./registry-download.ts", async (original) => ({
  ...(await original<object>()),
  downloadRegistryResource: mocks.download,
}));
vi.mock("./verification-worker-host.ts", () => ({ runVerificationWorker: mocks.worker }));
vi.mock("./keyd-verification.ts", () => ({ verifyReleaseKeyd: mocks.signature }));

// Transport, publisher verification and Apple signature have explicit test seams. Extraction,
// copying, trust records and the real Go install-lock command run without services or networking.
const roots: string[] = [],
  version = "1.2.3",
  commit = "b".repeat(40);
const signal = () => new AbortController().signal;
const hash = (body: Buffer, algorithm = "sha256") =>
  createHash(algorithm).update(body).digest("hex");
const versions = TufVersions.parse(
  Object.fromEntries(
    ["root", "timestamp", "snapshot", "targets"].map((role) => [
      role,
      { version: 1, sha256: "c".repeat(64) },
    ]),
  ),
);
let binary: Awaited<ReturnType<typeof buildTestKeyd>>, bytes: Buffer, archive: Buffer;
const document = JSON.stringify({
  attestations: [
    {
      predicateType: "https://slsa.dev/provenance/v1",
      bundle: {
        dsseEnvelope: {
          payloadType: "application/vnd.in-toto+json",
          payload: Buffer.from(
            JSON.stringify({
              predicate: {
                buildDefinition: {
                  resolvedDependencies: [
                    {
                      uri: `git+${RELEASE_PROVENANCE_PINS.repository}@refs/tags/v${version}`,
                      digest: { gitCommit: commit },
                    },
                  ],
                },
              },
            }),
          ).toString("base64"),
        },
      },
    },
  ],
});
function makeArchive(extra = {}) {
  return gzipSync(
    tarBytes([
      {
        name: "package/package.json",
        body: Buffer.from(
          JSON.stringify({ name: KEYD_PACKAGE, version, os: ["darwin"], cpu: ["arm64"], ...extra }),
        ),
      },
      { name: "package/bin/keyd", body: bytes, mode: 0o755 },
      { name: "package/LICENSE", body: Buffer.from("fixture license") },
      { name: "package/THIRD-PARTY.md", body: Buffer.from("fixture notice") },
    ]),
  );
}
beforeAll(async () => {
  binary = await buildTestKeyd();
  bytes = await readFile(binary.path);
  archive = makeArchive();
}, 65_000);
afterAll(() => binary?.dispose());
afterEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.useRealTimers();
});
async function fixture(input = archive) {
  const state = await realpath(await mkdtemp(join(tmpdir(), "localdot-bootstrap-")));
  roots.push(state);
  const events: string[] = [];
  mocks.download.mockImplementation(async function* (resource) {
    events.push(`download:${resource.kind}`);
    expect(resource.name).toBe(KEYD_PACKAGE);
    expect(resource.version).toBe(version);
    if (resource.kind === "archive") yield input;
    else if (resource.kind === "attestation") yield Buffer.from(document);
    else
      yield Buffer.from(
        JSON.stringify({
          name: KEYD_PACKAGE,
          version,
          dist: {
            tarball: registryResourceURL({ name: KEYD_PACKAGE, version, kind: "archive" }).href,
            integrity: `sha512-${createHash("sha512").update(input).digest("base64")}`,
            attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
          },
        }),
      );
  });
  mocks.worker.mockImplementation(async (_entry, data) => {
    events.push("trust");
    expect(data.artifact).toEqual({
      name: KEYD_PACKAGE,
      version,
      sha512: hash(input, "sha512"),
      commit,
    });
    return structuredClone(versions);
  });
  mocks.signature.mockImplementation(async (path, expected, active) => {
    active.throwIfAborted();
    events.push("signature");
    expect(hash(await readFile(path))).toBe(expected.sha256);
    expect(expected.teamId).toBe("87FD3FSZBG");
    return {
      path,
      sha256: expected.sha256,
      teamId: expected.teamId,
      identifier: expected.identifier,
    };
  });
  return { state, events, store: privateRecordStore(state, "trust-versions.json", TufVersions) };
}
it("authenticates before real helper execution and commits fresh trust under the retained kernel lock", async () => {
  const f = await fixture();
  mocks.worker.mockImplementationOnce(async () => {
    expect(await f.store.read()).toBeNull();
    expect(await readdir(f.state)).not.toContain("install.lock");
    return structuredClone(versions);
  });
  let callbackHelper = "";
  let inheritAfterReturn: (() => number) | undefined;
  const result = await withBootstrapInstallLock(f.state, version, signal(), async (helper) => {
    callbackHelper = helper.keydPath;
    expect(Object.isFrozen(helper)).toBe(true);
    expect(helper.installLifetime.directory).toBe(f.state);
    expect(helper.installLifetime.inheritDescriptor()).toBeGreaterThanOrEqual(0);
    inheritAfterReturn = helper.installLifetime.inheritDescriptor;
    expect(callbackHelper.startsWith(`${f.state}/.bootstrap-`)).toBe(true);
    expect(hash(await readFile(callbackHelper))).toBe(hash(await readFile(binary.path)));
    expect(await f.store.read()).toEqual(versions);
    expect(mocks.worker).toHaveBeenCalledTimes(2);
    expect(mocks.signature).toHaveBeenCalledTimes(4);
    await expect(
      withInstallLock(f.state, signal(), keydLockAcquirer(binary.path), async () => {}),
    ).rejects.toThrow("Another installation");
    return "installed callback";
  });
  expect(result).toBe("installed callback");
  expect(() => inheritAfterReturn?.()).toThrow("unsafe");
  await expect(readFile(callbackHelper)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(f.state)).sort()).toEqual([
    "bootstrap-leases",
    "install.lock",
    "trust-versions.json",
  ]);
  expect(await readdir(join(f.state, "bootstrap-leases"))).toEqual([]);
  await withInstallLock(f.state, signal(), keydLockAcquirer(binary.path), async () => {});
});
it.each(["preview", "signature", "advance-before-lock", "locked-recheck"])(
  "does not allow installation after %s failure",
  async (kind) => {
    const f = await fixture(),
      work = vi.fn();
    if (kind === "preview") mocks.worker.mockRejectedValueOnce(new Error("bad publisher"));
    if (kind === "signature") mocks.signature.mockRejectedValueOnce(new Error("bad signature"));
    const newer = structuredClone(versions);
    newer.timestamp.version = 2;
    if (kind === "advance-before-lock")
      mocks.worker.mockImplementationOnce(async () => {
        await f.store.save(newer);
        return versions;
      });
    if (kind === "locked-recheck")
      mocks.worker
        .mockResolvedValueOnce(versions)
        .mockRejectedValueOnce(new Error("fresh trust failed"));
    await expect(withBootstrapInstallLock(f.state, version, signal(), work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    const names = await readdir(f.state);
    expect(names.some((name) => name.startsWith(".bootstrap-"))).toBe(false);
    if (kind !== "locked-recheck") expect(names).not.toContain("install.lock");
    expect(await f.store.read()).toEqual(kind === "advance-before-lock" ? newer : null);
    if (kind === "preview") expect(mocks.signature).not.toHaveBeenCalled();
  },
);
it.each([{ version: "9.9.9" }, { scripts: { install: "forbidden" } }, { cpu: ["x64"] }])(
  "refuses helper metadata %j before execution",
  async (extra) => {
    const f = await fixture(makeArchive(extra));
    await expect(withBootstrapInstallLock(f.state, version, signal(), vi.fn())).rejects.toThrow();
    expect(mocks.signature).not.toHaveBeenCalled();
    expect(await readdir(f.state)).toEqual(["bootstrap-leases"]);
    expect(await readdir(join(f.state, "bootstrap-leases"))).toEqual([]);
  },
);
it("retains the lock and helper through callback cancellation until all work drains", async () => {
  const f = await fixture(),
    controller = new AbortController(),
    reason = new Error("cancelled");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    drained = new Promise<void>((r) => {
      release = r;
    });
  let settled = false;
  const run = withBootstrapInstallLock(f.state, version, controller.signal, async () => {
    enter();
    await drained;
  }).catch((e) => {
    settled = true;
    return e;
  });
  await entered;
  controller.abort(reason);
  await expect(
    withInstallLock(f.state, signal(), keydLockAcquirer(binary.path), async () => {}),
  ).rejects.toThrow("Another installation");
  expect(settled).toBe(false);
  expect((await readdir(f.state)).some((name) => name.startsWith(".bootstrap-"))).toBe(true);
  release();
  expect(await run).toBe(reason);
  expect((await readdir(f.state)).sort()).toEqual([
    "bootstrap-leases",
    "install.lock",
    "trust-versions.json",
  ]);
  expect(await readdir(join(f.state, "bootstrap-leases"))).toEqual([]);
});
it("ends acquisition deadlines before a long installation callback", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await withBootstrapInstallLock(f.state, version, signal(), async () => {
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(121_000);
  });
});
it("does no work on invalid version or pre-cancellation, and leaves no bootstrap after a callback failure", async () => {
  const f = await fixture(),
    controller = new AbortController();
  controller.abort(new Error("stop"));
  await expect(
    withBootstrapInstallLock(f.state, version, controller.signal, vi.fn()),
  ).rejects.toThrow("stop");
  await expect(withBootstrapInstallLock(f.state, "latest", signal(), vi.fn())).rejects.toThrow();
  expect(mocks.download).not.toHaveBeenCalled();
  await expect(
    withBootstrapInstallLock(f.state, version, signal(), async () => {
      throw new Error("installer failed");
    }),
  ).rejects.toThrow("installer failed");
  expect((await readdir(f.state)).sort()).toEqual([
    "bootstrap-leases",
    "install.lock",
    "trust-versions.json",
  ]);
  expect(await readdir(join(f.state, "bootstrap-leases"))).toEqual([]);
});
