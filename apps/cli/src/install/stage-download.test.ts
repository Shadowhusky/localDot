import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import { tarBytes } from "./testing/tar-fixture.ts";

const verified = vi.hoisted(() => vi.fn());
vi.mock("./verified-download.ts", () => ({ withVerifiedDownload: verified }));

import { withStagedDownload } from "./stage-download.ts";

const roots: string[] = [];
const signal = () => new AbortController().signal;
const hash = (body: Buffer, algorithm = "sha256") =>
  createHash(algorithm).update(body).digest("hex");
async function fixture(
  change: (
    manifest: ReturnType<typeof sampleManifest>,
    pkg: Record<string, unknown>,
  ) => void = () => {},
  extra = false,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-staged-download-")));
  roots.push(root);
  const body = Buffer.from("export default 'verified fixture';\n"),
    manifest = sampleManifest();
  manifest.files = { "dist/cli.mjs": hash(body) };
  const pkg: Record<string, unknown> = { name: "localdot", version: "1.0.0" };
  change(manifest, pkg);
  const bytes = gzipSync(
    tarBytes([
      { name: "package/package.json", body: Buffer.from(JSON.stringify(pkg)) },
      { name: "package/release.json", body: Buffer.from(JSON.stringify(manifest)) },
      { name: "package/dist/cli.mjs", body },
      ...(extra ? [{ name: "package/unlisted", body: Buffer.from("unlisted") }] : []),
    ]),
  );
  const archive = join(root, "release.tgz");
  await writeFile(archive, bytes, { mode: 0o400 });
  const release = {
    name: "localdot" as const,
    version: "1.0.0",
    commit: "0".repeat(40),
    archive,
    sha256: hash(bytes),
    sha512: hash(bytes, "sha512"),
    bytes: bytes.length,
    integrity: "unused",
    attestationJSON: "already verified at injected boundary",
  };
  verified.mockImplementation(async (parent, pkg, abort, work) => {
    expect(parent).toBe(root);
    expect(pkg).toEqual({ name: "localdot", version: "1.0.0" });
    return work(release, abort);
  });
  return { root, body, manifest, release };
}
afterEach(async () => {
  verified.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("joins authenticated archive hashes to extracted metadata and exact manifest inventory", async () => {
  const f = await fixture();
  const result = await withStagedDownload(f.root, "1.0.0", signal(), async (staged) => {
    expect(staged.inventory.manifest).toEqual(f.manifest);
    expect(staged.packageSha256).toBe(f.release.sha256);
    expect(staged.inventory.files).toBe(3);
    expect(await readFile(join(staged.root, "dist/cli.mjs"))).toEqual(f.body);
    return "staged";
  });
  expect(result).toBe("staged");
  expect(await readdir(f.root)).toEqual(["release.tgz"]);
});
it("extracts only beneath the supplied assembly scratch", async () => {
  const f = await fixture(),
    scratch = join(f.root, "assembly");
  await mkdir(scratch, { mode: 0o700 });
  await withStagedDownload(
    f.root,
    "1.0.0",
    signal(),
    async (staged) => {
      expect(staged.root.startsWith(`${scratch}/.extract-`)).toBe(true);
    },
    scratch,
  );
  expect(verified.mock.calls[0]?.[4]).toBe(scratch);
  expect(await readdir(scratch)).toEqual([]);
});
it.each(["version", "commit", "file-hash", "scripts", "extra-file"])(
  "refuses authenticated but inconsistent release %s",
  async (kind) => {
    const f = await fixture((manifest, pkg) => {
        if (kind === "version") {
          manifest.version = "2.0.0";
          pkg.version = "2.0.0";
        }
        if (kind === "commit") manifest.commit = "a".repeat(40);
        if (kind === "file-hash") manifest.files["dist/cli.mjs"] = "f".repeat(64);
        if (kind === "scripts") pkg.scripts = { postinstall: "do not run" };
      }, kind === "extra-file"),
      work = vi.fn();
    await expect(withStagedDownload(f.root, "1.0.0", signal(), work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual(["release.tgz"]);
  },
);
it("does not extract anything when provenance authentication rejects", async () => {
  const f = await fixture(),
    work = vi.fn();
  verified.mockRejectedValue(new Error("untrusted release"));
  await expect(withStagedDownload(f.root, "1.0.0", signal(), work)).rejects.toThrow(
    "untrusted release",
  );
  expect(work).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual(["release.tgz"]);
});
it("preserves cancellation after staging and removes only owned scratch", async () => {
  const f = await fixture(),
    controller = new AbortController(),
    reason = new Error("stop");
  await writeFile(join(f.root, "user-data"), "keep");
  await expect(
    withStagedDownload(f.root, "1.0.0", controller.signal, async () => {
      controller.abort(reason);
    }),
  ).rejects.toBe(reason);
  expect((await readdir(f.root)).sort()).toEqual(["release.tgz", "user-data"]);
});
