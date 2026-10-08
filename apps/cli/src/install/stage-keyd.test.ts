import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { KEYD_PACKAGE, ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import { type TarEntry, tarBytes } from "./testing/tar-fixture.ts";

const mocks = vi.hoisted(() => ({ download: vi.fn(), signature: vi.fn() }));
vi.mock("./verified-download.ts", () => ({ withVerifiedDownload: mocks.download }));
vi.mock("./keyd-verification.ts", () => ({ verifyReleaseKeyd: mocks.signature }));

import { withStagedKeyd } from "./stage-keyd.ts";

const roots: string[] = [],
  binary = Buffer.from("unsigned synthetic executable fixture");
const hash = (body: Buffer, algorithm = "sha256") =>
  createHash(algorithm).update(body).digest("hex");
const signal = () => new AbortController().signal;
async function fixture(
  change: (pkg: Record<string, unknown>, entries: TarEntry[]) => void = () => {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-stage-keyd-")));
  roots.push(root);
  const manifest = ReleaseManifest.parse({
    ...sampleManifest(),
    keyd: { ...sampleManifest().keyd, teamId: "87FD3FSZBG", sha256: hash(binary) },
  });
  const pkg: Record<string, unknown> = {
    name: KEYD_PACKAGE,
    version: manifest.version,
    os: ["darwin"],
    cpu: ["arm64"],
  };
  const entries: TarEntry[] = [
    { name: "package/bin/keyd", body: binary, mode: 0o755 },
    { name: "package/LICENSE", body: Buffer.from("MIT license fixture") },
    { name: "package/THIRD-PARTY.md", body: Buffer.from("license inventory fixture") },
    { name: "package/licenses/go.txt", body: Buffer.from("Go license fixture") },
  ];
  change(pkg, entries);
  entries.push({ name: "package/package.json", body: Buffer.from(JSON.stringify(pkg)) });
  const bytes = gzipSync(tarBytes(entries)),
    archive = join(root, "helper.tgz");
  await writeFile(archive, bytes, { mode: 0o400 });
  const release = {
    name: KEYD_PACKAGE,
    version: manifest.version,
    commit: manifest.commit,
    archive,
    sha512: hash(bytes, "sha512"),
    sha256: hash(bytes),
  };
  mocks.download.mockImplementation(async (parent, requested, abort, work) => {
    expect(parent).toBe(root);
    expect(requested).toEqual({ name: KEYD_PACKAGE, version: manifest.version });
    return work(release, abort);
  });
  mocks.signature.mockResolvedValue({});
  return { root, manifest, release };
}
afterEach(async () => {
  mocks.download.mockReset();
  mocks.signature.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("joins exact-version provenance, the app's executable digest and mandatory Apple verification", async () => {
  const f = await fixture();
  let called = false;
  await withStagedKeyd(f.root, f.manifest, signal(), async (helper) => {
    expect(mocks.signature).toHaveBeenCalledWith(
      helper.executable,
      f.manifest.keyd,
      expect.any(AbortSignal),
    );
    expect(helper.files["bin/keyd"]?.sha256).toBe(f.manifest.keyd.sha256);
    expect(helper.packageSha256).toBe(f.release.sha256);
    called = true;
  });
  expect(called).toBe(true);
  expect(await readdir(f.root)).toEqual(["helper.tgz"]);
});
it("extracts the helper only beneath the supplied assembly scratch", async () => {
  const f = await fixture(),
    scratch = join(f.root, "assembly");
  await mkdir(scratch, { mode: 0o700 });
  await withStagedKeyd(
    f.root,
    f.manifest,
    signal(),
    async (staged) => {
      expect(staged.root.startsWith(`${scratch}/.extract-`)).toBe(true);
    },
    scratch,
  );
  expect(mocks.download.mock.calls[0]?.[4]).toBe(scratch);
  expect(await readdir(scratch)).toEqual([]);
});
it.each([
  "name",
  "version",
  "os",
  "cpu",
  "scripts",
  "dependencies",
  "optionalDependencies",
  "devDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
  "bin",
  "gypfile",
])("rejects incorrect or executable package metadata %s", async (field) => {
  const f = await fixture((pkg) => {
      pkg[field] =
        field === "name"
          ? "other"
          : field === "version"
            ? "9.9.9"
            : field === "os"
              ? ["linux"]
              : field === "cpu"
                ? ["x64"]
                : { bad: "value" };
    }),
    work = vi.fn();
  await expect(withStagedKeyd(f.root, f.manifest, signal(), work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  expect(mocks.signature).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual(["helper.tgz"]);
});
it.each([
  "missing-license",
  "missing-notices",
  "foreign-file",
  "changed-binary",
  "executable-notice",
  "empty-notice",
])("refuses invalid helper contents %s", async (kind) => {
  const f = await fixture((_pkg, entries) => {
      if (kind === "missing-license") entries.splice(1, 1);
      if (kind === "missing-notices") entries.splice(2, 1);
      if (kind === "foreign-file")
        entries.push({ name: "package/other.js", body: Buffer.from("bad") });
      if (kind === "changed-binary")
        Object.assign(entries[0] ?? {}, { body: Buffer.from("changed") });
      if (kind === "executable-notice") Object.assign(entries[1] ?? {}, { mode: 0o755 });
      if (kind === "empty-notice") Object.assign(entries[2] ?? {}, { body: Buffer.alloc(0) });
    }),
    work = vi.fn();
  await expect(withStagedKeyd(f.root, f.manifest, signal(), work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual(["helper.tgz"]);
});
it.each(["commit", "signature", "cancelled"])(
  "never exposes a helper after %s failure",
  async (kind) => {
    const f = await fixture(),
      work = vi.fn(),
      controller = new AbortController(),
      reason = new Error("stop");
    if (kind === "commit") f.release.commit = "f".repeat(40);
    if (kind === "signature")
      mocks.signature.mockRejectedValue(new Error("invalid signing identity"));
    if (kind === "cancelled")
      mocks.signature.mockImplementation(async () => {
        controller.abort(reason);
      });
    await expect(withStagedKeyd(f.root, f.manifest, controller.signal, work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual(["helper.tgz"]);
  },
);
