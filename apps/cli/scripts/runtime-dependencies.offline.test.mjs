import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { projectRuntimeDependencies } from "./runtime-dependencies.mjs";
import { sampleRuntimeLock } from "./testing/runtime-lock.mjs";

let root, archives, projected, configuration, cacheWriter;
function npm(args, cwd, cache) {
  return spawnSync(
    "npm",
    [
      ...args,
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--fund=false",
      "--update-notifier=false",
      "--loglevel=error",
      "--registry=https://registry.npmjs.org",
      `--cache=${cache}`,
      `--userconfig=${configuration.user}`,
      `--globalconfig=${configuration.global}`,
    ],
    {
      cwd,
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "localdot-offline-dependency-install-"));
  const npmPath = spawnSync("which", ["npm"], { encoding: "utf8", timeout: 5_000 });
  if (npmPath.status !== 0) throw new Error("npm executable not found");
  // npm's own cache format, confined to this fixture's cache. Never touches the user's npm cache.
  cacheWriter = createRequire(await realpath(npmPath.stdout.trim()))("cacache");
  configuration = { user: join(root, "user.npmrc"), global: join(root, "global.npmrc") };
  await writeFile(configuration.user, "");
  await writeFile(configuration.global, "");
  const lock = sampleRuntimeLock(),
    metadata = {},
    out = join(root, "archives"),
    packCache = join(root, "pack-cache");
  archives = [];
  await mkdir(out);
  await mkdir(packCache);
  for (const [key, record] of Object.entries(lock.packages)) {
    const at = key.lastIndexOf("@"),
      name = key.slice(0, at),
      version = key.slice(at + 1);
    const dir = join(root, `source-${archives.length}`),
      snapshot = lock.snapshots[key];
    await mkdir(dir);
    const optionalDependencies = Object.fromEntries(
      Object.entries(snapshot.optionalDependencies ?? {}).filter(
        ([name]) => name !== "@types/node",
      ),
    );
    const pkg = {
      name,
      version,
      type: "module",
      main: "index.js",
      license: "MIT",
      dependencies: snapshot.dependencies,
      ...(Object.keys(optionalDependencies).length ? { optionalDependencies } : {}),
      ...(record.os ? { os: record.os } : {}),
      ...(record.cpu ? { cpu: record.cpu } : {}),
      ...(record.peerDependencies
        ? {
            peerDependencies: record.peerDependencies,
            peerDependenciesMeta: record.peerDependenciesMeta,
          }
        : {}),
      // All fixture packages would fail installation if any lifecycle script were executed.
      scripts: {
        preinstall: 'node -e "process.exit(97)"',
        install: 'node -e "process.exit(98)"',
        postinstall: 'node -e "process.exit(99)"',
      },
    };
    await writeFile(join(dir, "package.json"), `${JSON.stringify(pkg)}\n`);
    await writeFile(join(dir, "index.js"), `export const fixture = ${JSON.stringify(key)};\n`);
    metadata[name] = pkg;
    const packed = npm(["pack", "--json", "--pack-destination", out], dir, packCache);
    if (packed.status !== 0) throw new Error(`Fixture pack failed: ${packed.stderr}`);
    const [info] = JSON.parse(packed.stdout);
    record.resolution.integrity = info.integrity;
    archives.push({ name, path: join(out, info.filename), pkg, integrity: info.integrity });
  }
  projected = projectRuntimeDependencies({
    lock,
    version: "1.2.3",
    sharpVersion: "1.0.0",
    metadata,
  });
}, 30_000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
async function installation({ omit = [], changeManifest, nested = false } = {}) {
  const dir = await mkdtemp(join(root, "stage-")),
    cache = join(dir, "cache");
  await mkdir(cache);
  for (const artifact of archives) {
    if (omit.includes(artifact.name)) continue;
    const added = npm(["cache", "add", artifact.path], dir, cache);
    if (added.status !== 0) throw new Error(`Fixture cache preparation failed: ${added.stderr}`);
    if (nested) {
      const url = `https://registry.npmjs.org/${artifact.name.replace("/", "%2f")}`;
      const entry = projected.shrinkwrap.packages[`node_modules/${artifact.name}`];
      const version = {
        ...artifact.pkg,
        dist: { tarball: entry.resolved, integrity: artifact.integrity },
      };
      const body = JSON.stringify({
        name: artifact.name,
        "dist-tags": { latest: artifact.pkg.version },
        versions: { [artifact.pkg.version]: version },
      });
      for (const accept of [
        "application/json",
        "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
      ])
        await cacheWriter.put(
          join(cache, "_cacache"),
          `make-fetch-happen:request-cache:${url}`,
          body,
          {
            metadata: {
              time: Date.now(),
              url,
              reqHeaders: { accept },
              resHeaders: {
                "content-type": "application/json",
                "cache-control": "public, max-age=86400",
                date: new Date().toUTCString(),
              },
              options: { compress: true },
            },
          },
        );
    }
  }
  const pkg = structuredClone(projected.packageJson);
  if (changeManifest) changeManifest(pkg);
  await writeFile(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFile(
    join(dir, "npm-shrinkwrap.json"),
    `${JSON.stringify(projected.shrinkwrap, null, 2)}\n`,
  );
  if (nested) {
    const packed = npm(["pack", "--json", "--pack-destination", root], dir, cache);
    if (packed.status !== 0) throw new Error(`Fixture app pack failed: ${packed.stderr}`);
    const consumer = await mkdtemp(join(root, "consumer-"));
    await writeFile(
      join(consumer, "package.json"),
      '{"name":"consumer","version":"1.0.0","private":true}\n',
    );
    const archive = join(root, JSON.parse(packed.stdout)[0].filename);
    const result = npm(["install", archive, "--os=darwin", "--cpu=arm64"], consumer, cache);
    return { dir: consumer, result };
  }
  const result = npm(["ci", "--os=darwin", "--cpu=arm64"], dir, cache);
  return { dir, result };
}

it("npm installs the exact required graph offline, skips the other architecture and runs no lifecycle hooks", async () => {
  const { dir, result } = await installation({
    omit: ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64"],
  });
  expect(result.status, result.stderr).toBe(0);
  for (const name of [
    "sharp",
    "codec",
    "transitive",
    "@img/sharp-darwin-arm64",
    "@img/sharp-libvips-darwin-arm64",
  ]) {
    const pkg = JSON.parse(await readFile(join(dir, "node_modules", name, "package.json"), "utf8"));
    expect(pkg.version).toBe(projected.shrinkwrap.packages[`node_modules/${name}`].version);
  }
  await expect(stat(join(dir, "node_modules/@img/sharp-darwin-x64"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(join(dir, "node_modules/@types/node"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(JSON.parse(await readFile(join(dir, "npm-shrinkwrap.json"), "utf8"))).toEqual(
    projected.shrinkwrap,
  );
}, 30_000);

it("npm fails instead of silently omitting a required native dependency whose archive is unavailable", async () => {
  const { result } = await installation({ omit: ["@img/sharp-darwin-arm64"] });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("ENOTCACHED");
}, 30_000);

it("the packed application's shrinkwrap also constrains installation as a dependency", async () => {
  const { dir, result } = await installation({
    nested: true,
    omit: ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64"],
  });
  expect(result.status, result.stderr).toBe(0);
  const installed = JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8"));
  const app = JSON.parse(
    await readFile(join(dir, "node_modules/localdot/npm-shrinkwrap.json"), "utf8"),
  );
  expect(app).toEqual(projected.shrinkwrap);
  for (const name of [
    "sharp",
    "codec",
    "transitive",
    "@img/sharp-darwin-arm64",
    "@img/sharp-libvips-darwin-arm64",
  ]) {
    const expected = projected.shrinkwrap.packages[`node_modules/${name}`];
    const matches = Object.entries(installed.packages).filter(
      ([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`,
    );
    expect(matches.length).toBeGreaterThan(0);
    for (const [, entry] of matches) {
      expect(entry.version).toBe(expected.version);
      expect(entry.integrity).toBe(expected.integrity);
    }
  }
}, 30_000);

it("npm refuses a manifest that drifts from the generated pinned version", async () => {
  const { result } = await installation({
    changeManifest: (pkg) => {
      pkg.dependencies.sharp = "9.9.9";
    },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/EUSAGE|ENOTCACHED/);
}, 30_000);
