import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TufVersions } from "../../../../packages/protocol/src/install-update.ts";
import { privateRecordStore } from "./private-record.ts";
import { createSigstoreVerifier } from "./sigstore-verifier.ts";
import { tufFixture } from "./testing/tuf-fixture.ts";
import { checkedTufURL, MAX_TUF_BYTES, SIGSTORE_TUF_MIRROR, tufFetcher } from "./tuf-fetcher.ts";
import { refreshSigstoreRoot } from "./tuf-root.ts";

const dirs: string[] = [];
const signal = () => new AbortController().signal;
async function directory() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "localdot-tuf-test-")));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("checks real TUF signatures, role binding and target bytes from an independent seed", async () => {
  const f = tufFixture();
  const dir = await directory();
  const result = await refreshSigstoreRoot(
    dir,
    null,
    signal(),
    tufFetcher(dir, signal(), f.download),
    f.seed,
  );
  expect(result.rootJSON).toBe(f.bytes.toString());
  expect(result.versions.timestamp.version).toBe(1);
  expect(f.calls).toEqual([
    "/2.root.json",
    "/timestamp.json",
    "/snapshot.json",
    "/targets.json",
    "/targets/trusted_root.json",
  ]);
  expect((await readdir(dir)).sort()).toEqual(["metadata", "targets"]);
});

for (const role of ["root", "timestamp", "snapshot", "targets"]) {
  it(`rejects expired ${role} metadata`, async () => {
    const f = tufFixture({ expired: role });
    const dir = await directory();
    await expect(
      refreshSigstoreRoot(dir, null, signal(), tufFetcher(dir, signal(), f.download), f.seed),
    ).rejects.toThrow("Signing trust metadata did not verify.");
  });
}
for (const path of [
  "/timestamp.json",
  "/snapshot.json",
  "/targets.json",
  "/targets/trusted_root.json",
]) {
  it(`rejects tampered ${path}`, async () => {
    const f = tufFixture();
    const dir = await directory();
    const bytes = f.files.get(path);
    if (!bytes) throw new Error("fixture missing");
    if (path.endsWith("trusted_root.json"))
      f.files.set(path, Buffer.from("untrusted target bytes"));
    else {
      const value = JSON.parse(bytes.toString());
      value.signed.expires = "2999-01-01T00:00:00Z";
      f.files.set(path, Buffer.from(JSON.stringify(value)));
    }
    await expect(
      refreshSigstoreRoot(dir, null, signal(), tufFetcher(dir, signal(), f.download), f.seed),
    ).rejects.toThrow("Signing trust metadata did not verify.");
  });
}

it("persists role floors and refuses lower versions or changed same-version bytes across runs", async () => {
  const f = tufFixture();
  const dir = await directory();
  const first = await refreshSigstoreRoot(
    dir,
    null,
    signal(),
    tufFetcher(dir, signal(), f.download),
    f.seed,
  );
  const install = await directory();
  const store = privateRecordStore(install, "trust-versions.json", TufVersions);
  await store.save(first.versions);
  const previous = await privateRecordStore(install, "trust-versions.json", TufVersions).read();
  const nextDir = await directory();
  await expect(
    refreshSigstoreRoot(
      nextDir,
      previous,
      signal(),
      tufFetcher(nextDir, signal(), f.download),
      f.seed,
    ),
  ).resolves.toEqual(first);
  for (const role of ["root", "timestamp", "snapshot", "targets"] as const) {
    for (const change of ["version", "hash"]) {
      const floor = structuredClone(first.versions);
      if (change === "version") floor[role].version++;
      else floor[role].sha256 = "0".repeat(64);
      const d = await directory();
      await expect(
        refreshSigstoreRoot(d, floor, signal(), tufFetcher(d, signal(), f.download), f.seed),
      ).rejects.toThrow("Signing trust metadata did not verify.");
    }
  }
});

it("refuses another publisher's root rotation", async () => {
  const f = tufFixture();
  const other = tufFixture({ version: 2 });
  const dir = await directory();
  f.files.set("/2.root.json", Buffer.from(other.seed));
  await expect(
    refreshSigstoreRoot(dir, null, signal(), tufFetcher(dir, signal(), f.download), f.seed),
  ).rejects.toThrow("Signing trust metadata did not verify.");
});

it("accepts an authenticated root rotation and verifies a real attestation through the acquired target", async () => {
  const root = await readFile(
    new URL("./testing/sigstore/trusted-root.json", import.meta.url),
    "utf8",
  );
  const bundle = JSON.parse(
    await readFile(new URL("./testing/sigstore/bundle.json", import.meta.url), "utf8"),
  );
  const f = tufFixture({ target: root });
  const dir = await directory();
  f.files.set("/2.root.json", f.rotateRoot(2));
  const acquired = await refreshSigstoreRoot(
    dir,
    null,
    signal(),
    tufFetcher(dir, signal(), f.download),
    f.seed,
  );
  expect(acquired.versions.root.version).toBe(2);
  expect(f.calls.slice(0, 2)).toEqual(["/2.root.json", "/3.root.json"]);
  await expect(
    createSigstoreVerifier(acquired.rootJSON)(
      bundle,
      {
        certificateIdentityURI:
          "^https://github\\.com/sigstore/sigstore-js/\\.github/workflows/release\\.yml@refs/heads/main$",
        certificateIssuer: "https://token.actions.githubusercontent.com",
        ctLogThreshold: 1,
        tlogThreshold: 1,
      },
      signal(),
    ),
  ).resolves.toBeUndefined();
});

it("requires empty private storage and preserves cancellation", async () => {
  const f = tufFixture();
  for (const kind of ["populated", "permissions"]) {
    const dir = await directory();
    if (kind === "populated") await writeFile(join(dir, "old-root.json"), f.seed);
    else await chmod(dir, 0o755);
    await expect(
      refreshSigstoreRoot(dir, null, signal(), tufFetcher(dir, signal(), f.download), f.seed),
    ).rejects.toThrow("Signing trust metadata did not verify.");
  }
  const dir = await directory();
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);
  await expect(refreshSigstoreRoot(dir, null, controller.signal)).rejects.toBe(reason);
  expect(await readdir(dir)).toEqual([]);
});

it("pins the initial Sigstore root distributed by @sigstore/tuf 5.0.0", async () => {
  const bytes = await readFile(new URL("./sigstore-tuf-root.json", import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "bc232178369634dc10c4d34df3ef64fa2ae642d5dc2c019335a1c22ba700319b",
  );
  expect(JSON.parse(bytes.toString()).signed.version).toBe(15);
});

it("confines downloads to the pinned mirror, finite files and per-request size", async () => {
  for (const path of [
    "https://other.invalid/timestamp.json",
    `${SIGSTORE_TUF_MIRROR}/timestamp.json?x=1`,
    `${SIGSTORE_TUF_MIRROR}/evil.json`,
    `${SIGSTORE_TUF_MIRROR}/targets/other.json`,
    `${SIGSTORE_TUF_MIRROR}/../timestamp.json`,
    `${SIGSTORE_TUF_MIRROR}/%74imestamp.json`,
  ])
    expect(() => checkedTufURL(path)).toThrow();
  const dir = await directory();
  let calls = 0;
  const fetcher = tufFetcher(dir, signal(), async () => {
    calls++;
    return Buffer.from("exceeds");
  });
  await expect(
    fetcher.downloadBytes(`${SIGSTORE_TUF_MIRROR}/timestamp.json`, MAX_TUF_BYTES + 1),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(
    fetcher.downloadFile(`${SIGSTORE_TUF_MIRROR}/timestamp.json`, 2, async () => "bad"),
  ).rejects.toThrow();
  expect(await readdir(dir)).toEqual([]);
  await expect(
    fetcher.downloadFile(`${SIGSTORE_TUF_MIRROR}/timestamp.json`, 100, async () => {
      throw new Error("handler failure");
    }),
  ).rejects.toThrow("handler failure");
  expect(await readdir(dir)).toEqual([]);
});
