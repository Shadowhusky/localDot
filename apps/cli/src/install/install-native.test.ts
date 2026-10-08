import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { ReleaseManifest } from "../../../../packages/protocol/src/release.ts";
import { sampleManifest } from "../../../../packages/protocol/src/testing/sample-release.ts";
import { installNativeDependencies } from "./install-native.ts";
import { prepareNativeDependencies } from "./prepare-native.ts";
import type { NativeArchiveDownload } from "./registry-download.ts";
import { fixtureNames, nativeFixture } from "./testing/native-fixture.ts";
import { tarBytes } from "./testing/tar-fixture.ts";

const roots: string[] = [],
  hash = (body: Buffer, algorithm = "sha256") => createHash(algorithm).update(body).digest("hex");
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "localdot-native-install-")));
  roots.push(root);
  const directory = join(root, "candidate"),
    app = join(directory, "app");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(app, { mode: 0o700 });
  const f = nativeFixture(),
    archives: Record<string, string> = {};
  for (const name of fixtureNames) {
    // If any lifecycle script were run, this fixture would fail installation.
    const meta = Buffer.from(
      JSON.stringify({
        name,
        version: "1.0.0",
        scripts: { preinstall: "exit 97", install: "exit 98", postinstall: "exit 99" },
      }),
    );
    const archive = gzipSync(
        tarBytes([
          { name: "package/package.json", body: meta },
          { name: "package/index.js", body: Buffer.from("fixture content; never executed") },
        ]),
      ),
      path = join(root, `${name.replace(/[^a-z0-9]/g, "-")}.tgz`);
    await writeFile(path, archive, { mode: 0o400 });
    archives[name] = path;
    Object.assign(f.lock.packages[`node_modules/${name}`] ?? {}, {
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    });
  }
  const pkg = Buffer.from(JSON.stringify(f.pkg)),
    lock = Buffer.from(JSON.stringify(f.lock));
  const manifest = ReleaseManifest.parse({
      ...sampleManifest(),
      files: { "npm-shrinkwrap.json": hash(lock) },
    }),
    release = Buffer.from(JSON.stringify(manifest));
  for (const [name, bytes] of [
    ["package.json", pkg],
    ["npm-shrinkwrap.json", lock],
    ["release.json", release],
  ] as const)
    await writeFile(join(app, name), bytes, { mode: 0o600 });
  await writeFile(join(directory, "keep"), "unrelated");
  const candidate = {
    directory,
    app,
    keyd: "unused",
    manifest,
    metadataDigests: { packageJson: hash(pkg), releaseJson: hash(release) },
    assemblySha256: "b".repeat(64),
    identity: { version: "1.0.0", packageSha256: "a".repeat(64), manifestSha256: hash(release) },
    dispose: async () => {},
  };
  return { root, candidate, archives };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function clean(directory: string) {
  expect((await readdir(directory)).sort()).toEqual(["app", "keep"]);
  expect(await readFile(join(directory, "keep"), "utf8")).toBe("unrelated");
}
it("installs only locked archives without invoking package lifecycle scripts", async () => {
  const f = await fixture(),
    probe = vi.fn(async (root, version) => {
      expect(version).toBe("1.0.0");
      expect(await readFile(join(root, "sharp/index.js"), "utf8")).toContain("never executed");
      return { sharp: version, vips: "1.2.3" };
    });
  const result = await installNativeDependencies(f.candidate, f.archives, signal(), probe);
  expect(result.packages).toHaveLength(6);
  expect(Object.keys(result.files)).toHaveLength(12);
  expect(probe).toHaveBeenCalledTimes(1);
  expect((await readdir(f.candidate.directory)).sort()).toEqual([
    "app",
    "keep",
    "native.json",
    "node_modules",
  ]);
  expect(
    JSON.parse(await readFile(join(f.candidate.directory, "native.json"), "utf8")).files,
  ).toEqual(result.files);
});
it.each([
  "missing-archive",
  "wrong-archive",
  "probe-failure",
  "probe-mutation",
  "probe-extra-file",
  "cancelled",
])("cleans only owned native state after %s", async (kind) => {
  const f = await fixture(),
    controller = new AbortController(),
    reason = new Error("stop");
  if (kind === "missing-archive") delete f.archives.semver;
  if (kind === "wrong-archive") f.archives.semver = f.archives.sharp ?? "";
  const probe = vi.fn(async (root, version) => {
    if (kind === "probe-failure") throw new Error("binding missing");
    if (kind === "probe-mutation") await writeFile(join(root, "sharp/index.js"), "changed");
    if (kind === "probe-extra-file") await writeFile(join(root, "foreign"), "extra");
    if (kind === "cancelled") controller.abort(reason);
    return { sharp: version, vips: "1.2.3" };
  });
  await expect(
    installNativeDependencies(f.candidate, f.archives, controller.signal, probe),
  ).rejects.toThrow();
  await clean(f.candidate.directory);
});
it.each(["node_modules", "native.json"])("preserves pre-existing %s", async (name) => {
  const f = await fixture(),
    path = join(f.candidate.directory, name),
    probe = vi.fn();
  if (name === "node_modules") await mkdir(path);
  else await writeFile(path, "preserve");
  await expect(
    installNativeDependencies(f.candidate, f.archives, signal(), probe),
  ).rejects.toThrow();
  expect(probe).not.toHaveBeenCalled();
  if (name === "native.json") expect(await readFile(path, "utf8")).toBe("preserve");
  else expect(await readdir(path)).toEqual([]);
});

it("composes authenticated app metadata, downloaded bytes and native installation", async () => {
  const f = await fixture(),
    requested: string[] = [];
  const download: NativeArchiveDownload = async function* (pkg) {
    requested.push(pkg.name);
    yield await readFile(f.archives[pkg.name] ?? "");
  };
  const probe = vi.fn(async (_root, version) => ({ sharp: version, vips: "1.2.3" }));
  const receipt = await prepareNativeDependencies(f.candidate, signal(), download, probe);
  expect(requested.sort()).toEqual([...fixtureNames].sort());
  expect(Object.keys(receipt.files)).toHaveLength(12);
  expect(probe).toHaveBeenCalledOnce();
  expect((await readdir(f.candidate.directory)).sort()).toEqual([
    "app",
    "keep",
    "native.json",
    "node_modules",
  ]);
});
it.each(["unauthenticated-lock", "corrupt-download", "lock-changed-during-download"])(
  "does not run native code after %s",
  async (kind) => {
    const f = await fixture(),
      probe = vi.fn();
    const lock = join(f.candidate.app, "npm-shrinkwrap.json");
    if (kind === "unauthenticated-lock") await writeFile(lock, "changed");
    const download = vi.fn<NativeArchiveDownload>(async function* (pkg) {
      if (kind === "lock-changed-during-download") await writeFile(lock, "changed");
      yield kind === "corrupt-download"
        ? Buffer.from("corrupt")
        : await readFile(f.archives[pkg.name] ?? "");
    });
    await expect(
      prepareNativeDependencies(f.candidate, signal(), download, probe),
    ).rejects.toThrow();
    expect(probe).not.toHaveBeenCalled();
    if (kind === "unauthenticated-lock") expect(download).not.toHaveBeenCalled();
    await clean(f.candidate.directory);
  },
);
