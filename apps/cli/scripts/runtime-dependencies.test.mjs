import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WORKSPACE } from "./build-options.mjs";
import {
  projectRuntimeDependencies,
  readPnpmLock,
  writeRuntimeDependencies,
} from "./runtime-dependencies.mjs";
import { sampleRuntimeLock } from "./testing/runtime-lock.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const project = (lock) =>
  projectRuntimeDependencies({ lock, version: "1.2.3", sharpVersion: "1.0.0" });

it("projects the actual32-package frozen graph with all six required packages and no development peer", async () => {
  const root = await mkdtemp(join(tmpdir(), "localdot-real-runtime-lock-"));
  roots.push(root);
  const receipt = await writeRuntimeDependencies({ output: root, version: "0.0.0-rc.0" });
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")),
    shrinkwrap = JSON.parse(await readFile(join(root, "npm-shrinkwrap.json"), "utf8")),
    original = readPnpmLock(await readFile(join(WORKSPACE, "pnpm-lock.yaml")));
  expect(receipt.graph).toHaveLength(32);
  expect(
    receipt.graph
      .filter((value) => !value.optional)
      .map((value) => value.name)
      .sort(),
  ).toEqual(
    [
      "@img/colour",
      "@img/sharp-darwin-arm64",
      "@img/sharp-libvips-darwin-arm64",
      "detect-libc",
      "semver",
      "sharp",
    ].sort(),
  );
  expect(packageJson.dependencies).toEqual({
    sharp: "0.35.5",
    "@img/sharp-darwin-arm64": "0.35.5",
    "@img/sharp-libvips-darwin-arm64": "1.3.4",
  });
  expect(packageJson.private).toBe(true);
  expect(packageJson.scripts).toBeUndefined();
  expect(shrinkwrap.packages["node_modules/sharp"].integrity).toBe(
    original.packages["sharp@0.35.5"].resolution.integrity,
  );
  expect(shrinkwrap.packages["node_modules/@types/node"]).toBeUndefined();
  expect(shrinkwrap.packages["node_modules/semver"].bin).toEqual({ semver: "bin/semver.js" });
  expect(shrinkwrap.packages["node_modules/@img/sharp-libvips-linuxmusl-x64"].libc).toEqual([
    "musl",
  ]);
  expect(receipt.actualArchivesVerified).toBe(false);
  expect(receipt.cleanInstallVerified).toBe(false);
  await expect(
    writeRuntimeDependencies({ output: root, version: "0.0.0-rc.0" }),
  ).rejects.toMatchObject({ code: "EEXIST" });
});

it("keeps the graph complete but promotes the supported native binaries to mandatory", () => {
  const { shrinkwrap, packageJson, graph } = project(sampleRuntimeLock());
  expect(
    graph
      .filter((value) => !value.optional)
      .map((value) => value.name)
      .sort(),
  ).toEqual(
    [
      "sharp",
      "codec",
      "transitive",
      "@img/sharp-darwin-arm64",
      "@img/sharp-libvips-darwin-arm64",
    ].sort(),
  );
  expect(shrinkwrap.packages["node_modules/@img/sharp-darwin-x64"].optional).toBe(true);
  expect(shrinkwrap.packages["node_modules/@img/sharp-libvips-darwin-x64"].optional).toBe(true);
  expect(shrinkwrap.packages["node_modules/@img/sharp-darwin-arm64"].optional).toBeUndefined();
  expect(packageJson.cpu).toEqual(["arm64"]);
  expect(packageJson.os).toEqual(["darwin"]);
  expect(shrinkwrap.packages["node_modules/codec"].dependencies).toEqual({ transitive: "3.0.0" });
});

it.each([
  (lock) => {
    lock.packages["sharp@1.0.0"].resolution.integrity = "sha1-old";
  },
  (lock) => {
    lock.packages["sharp@1.0.0"].resolution.tarball = "https://untrusted.invalid/replacement.tgz";
  },
  (lock) => {
    lock.snapshots["sharp@1.0.0"].dependencies.codec = "^2.0.0";
  },
  (lock) => {
    delete lock.snapshots["codec@2.0.0"];
  },
  (lock) => {
    delete lock.snapshots["sharp@1.0.0"].optionalDependencies["@img/sharp-darwin-arm64"];
  },
  (lock) => {
    lock.packages["@img/sharp-darwin-arm64@1.0.0"].cpu = ["x64"];
  },
  (lock) => {
    lock.snapshots["sharp@1.0.0"].dependencies["../escape"] = "1.0.0";
  },
  (lock) => {
    lock.packages["sharp@1.0.0"].peerDependenciesMeta["@types/node"].optional = false;
  },
  (lock) => {
    lock.importers["apps/daemon"].dependencies.sharp.specifier = "^1.0.0";
  },
  (lock) => {
    lock.lockfileVersion = "8.0";
  },
])("fails on missing, drifting, untrusted or unsupported lock input", (mutate) => {
  const lock = sampleRuntimeLock();
  mutate(lock);
  expect(() => project(lock)).toThrow();
});
it("rejects two versions of the same flattened runtime dependency", () => {
  const lock = sampleRuntimeLock();
  lock.packages["codec@2.1.0"] = structuredClone(lock.packages["codec@2.0.0"]);
  lock.snapshots["codec@2.1.0"] = {};
  lock.snapshots["@img/sharp-darwin-arm64@1.0.0"].dependencies = { codec: "2.1.0" };
  expect(() => project(lock)).toThrow("Conflicting");
});
it("rejects YAML object tags and aliases instead of instantiating or expanding them", () => {
  expect(() => readPnpmLock(Buffer.from("--- !ruby/object:Object {}\n"))).toThrow();
  expect(() => readPnpmLock(Buffer.from("first: &node [1,2]\nsecond: *node\n"))).toThrow();
});
