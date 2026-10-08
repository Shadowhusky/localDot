import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import type { ExtractedFile } from "./extract-release.ts";

const mocks = vi.hoisted(() => ({ app: vi.fn(), keyd: vi.fn(), signature: vi.fn() }));
vi.mock("./stage-download.ts", () => ({ withStagedDownload: mocks.app }));
vi.mock("./stage-keyd.ts", () => ({ withStagedKeyd: mocks.keyd }));
vi.mock("./keyd-verification.ts", () => ({ verifyReleaseKeyd: mocks.signature }));

import { assembleRelease } from "./assemble-release.ts";

const roots: string[] = [],
  binary = Buffer.from("unsigned fixture executable"),
  appBytes = Buffer.from("export default 'fixture';\n");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const signal = () => new AbortController().signal;
async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "localdot-assembly-")));
  roots.push(parent);
  const app = join(parent, "app-source"),
    keyd = join(parent, "keyd-source");
  await mkdir(app, { mode: 0o700 });
  await mkdir(keyd, { mode: 0o700 });
  await mkdir(join(app, "dist"), { mode: 0o700 });
  await mkdir(join(keyd, "bin"), { mode: 0o700 });
  const manifest = ReleaseManifest.parse({
    ...sampleManifest(),
    files: { "dist/cli.mjs": hash(appBytes) },
    keyd: { ...sampleManifest().keyd, sha256: hash(binary), teamId: "87FD3FSZBG" },
  });
  const pkg = Buffer.from(JSON.stringify({ name: "localdot", version: manifest.version })),
    meta = Buffer.from(JSON.stringify(manifest));
  const files: Record<string, ExtractedFile> = {};
  for (const [path, body] of [
    ["package.json", pkg],
    ["release.json", meta],
    ["dist/cli.mjs", appBytes],
  ] as const) {
    await writeFile(join(app, path), body, { mode: 0o600 });
    files[path] = { sha256: hash(body), bytes: body.length, mode: 0o600 };
  }
  await writeFile(join(keyd, "bin/keyd"), binary, { mode: 0o700 });
  await writeFile(join(parent, "user-data"), "preserve");
  const staged = {
    root: app,
    packageSha256: "a".repeat(64),
    files,
    inventory: {
      manifest,
      metadataDigests: { packageJson: hash(pkg), releaseJson: hash(meta) },
      files: 3,
      bytes: pkg.length + meta.length + appBytes.length,
    },
  };
  const helper = {
    root: keyd,
    executable: join(keyd, "bin/keyd"),
    packageSha256: "b".repeat(64),
    files: { "bin/keyd": { sha256: hash(binary), bytes: binary.length, mode: 0o700 } },
  };
  mocks.app.mockImplementation(async (dir, version, abort, work, scratch) => {
    expect(dir).toBe(parent);
    expect(version).toBe(manifest.version);
    const record = JSON.parse(await readFile(join(parent, "assembly-scratch.json"), "utf8"));
    expect(scratch).toBe(join(parent, record.name));
    return work(staged, abort);
  });
  mocks.keyd.mockImplementation(async (dir, expected, abort, work, scratch) => {
    expect(dir).toBe(parent);
    expect(expected).toEqual(manifest);
    const record = JSON.parse(await readFile(join(parent, "assembly-scratch.json"), "utf8"));
    expect(scratch).toBe(join(parent, record.name));
    return work(helper, abort);
  });
  mocks.signature.mockResolvedValue({});
  const lifetime = { directory: parent, inheritDescriptor: () => 42 };
  return { parent, app, keyd, staged, helper, manifest, lifetime };
}
afterEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function clean(parent: string) {
  expect((await readdir(parent)).sort()).toEqual([
    "app-source",
    "assembly-scratch.json",
    "keyd-source",
    "user-data",
  ]);
  expect(await readFile(join(parent, "assembly-scratch.json"), "utf8")).toBe("null\n");
  expect(await readFile(join(parent, "user-data"), "utf8")).toBe("preserve");
}
it("assembles verified copies with a bound preparation receipt and explicit owned disposal", async () => {
  const f = await fixture(),
    prepared = await assembleRelease(f.parent, "1.0.0", signal(), f.lifetime);
  expect(await readFile(join(prepared.app, "dist/cli.mjs"))).toEqual(appBytes);
  expect(await readFile(prepared.keyd)).toEqual(binary);
  expect(mocks.signature).toHaveBeenCalledWith(
    prepared.keyd,
    f.manifest.keyd,
    expect.any(AbortSignal),
  );
  const receipt = JSON.parse(await readFile(join(prepared.directory, "assembly.json"), "utf8"));
  expect(receipt).toMatchObject({
    v: 1,
    phase: "assembled",
    identity: {
      version: "1.0.0",
      packageSha256: f.staged.packageSha256,
      manifestSha256: f.staged.inventory.metadataDigests.releaseJson,
    },
    commit: f.manifest.commit,
    keydPackageSha256: f.helper.packageSha256,
  });
  expect(receipt.appFiles).toEqual(f.staged.files);
  expect(receipt.keydFiles).toEqual(f.helper.files);
  expect(prepared.assemblySha256).toBe(
    hash(await readFile(join(prepared.directory, "assembly.json"))),
  );
  expect((await lstat(prepared.directory)).mode & 0o7777).toBe(0o700);
  // No selected release or service state is written by preparation.
  expect(await readdir(prepared.directory)).toEqual(["app", "assembly.json", "keyd"]);
  await Promise.all([prepared.dispose(), prepared.dispose()]);
  await prepared.dispose();
  await clean(f.parent);
});
it.each(["app-acquisition", "keyd-acquisition", "source-hash", "signature", "copied-app"])(
  "cleans only owned assembly after %s failure",
  async (kind) => {
    const f = await fixture();
    if (kind === "app-acquisition") mocks.app.mockRejectedValue(new Error("app failed"));
    if (kind === "keyd-acquisition") mocks.keyd.mockRejectedValue(new Error("helper failed"));
    if (kind === "source-hash")
      await writeFile(join(f.app, "dist/cli.mjs"), Buffer.alloc(appBytes.length));
    if (kind === "signature") mocks.signature.mockRejectedValue(new Error("signature failed"));
    if (kind === "copied-app")
      mocks.keyd.mockImplementation(async (_dir, _manifest, abort, work) => {
        const assembly = (await readdir(f.parent)).find((name) => name.startsWith(".assembly-"));
        await writeFile(
          join(f.parent, assembly ?? "missing", "app/dist/cli.mjs"),
          Buffer.alloc(appBytes.length),
        );
        return work(f.helper, abort);
      });
    await expect(assembleRelease(f.parent, "1.0.0", signal(), f.lifetime)).rejects.toThrow();
    await clean(f.parent);
  },
);
it("drains cancellation and removes the incomplete assembly", async () => {
  const f = await fixture(),
    controller = new AbortController(),
    reason = new Error("stop");
  mocks.signature.mockImplementation(async () => {
    controller.abort(reason);
  });
  await expect(assembleRelease(f.parent, "1.0.0", controller.signal, f.lifetime)).rejects.toBe(
    reason,
  );
  await clean(f.parent);
});
it("refuses disposal after its directory pathname is replaced", async () => {
  const f = await fixture(),
    prepared = await assembleRelease(f.parent, "1.0.0", signal(), f.lifetime);
  const retained = join(f.parent, "retained-owned-tree");
  await rename(prepared.directory, retained);
  await mkdir(prepared.directory, { mode: 0o700 });
  await writeFile(join(prepared.directory, "keep"), "unrelated replacement");
  await expect(prepared.dispose()).rejects.toThrow("ownership or lifetime changed");
  expect(await readFile(join(prepared.directory, "keep"), "utf8")).toBe("unrelated replacement");
  expect(await readFile(join(retained, "keyd/bin/keyd"))).toEqual(binary);
});
