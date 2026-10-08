import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runtimeBuildOptions, WORKSPACE } from "./build-options.mjs";

const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
const NATIVE = ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"];
const HOOKS = ["preinstall", "install", "postinstall"];
const ordered = (entries) => Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));

function versionOf(reference) {
  if (typeof reference !== "string" || reference.length > 512)
    throw new Error("Invalid dependency pin");
  const version = reference.split("(")[0];
  if (!EXACT.test(version)) throw new Error("Runtime dependencies must have exact versions");
  return version;
}
function own(map, name) {
  if (!map || !Object.hasOwn(map, name)) throw new Error("Missing locked runtime dependency");
  return map[name];
}
function platformFields(meta) {
  const fields = {};
  for (const key of ["os", "cpu", "libc"]) {
    if (meta[key] !== undefined) {
      if (
        !Array.isArray(meta[key]) ||
        !meta[key].length ||
        meta[key].length > 16 ||
        meta[key].some((value) => typeof value !== "string" || !/^!?[a-z0-9_-]+$/.test(value))
      )
        throw new Error("Invalid dependency platform metadata");
      fields[key] = [...meta[key]];
    }
  }
  if (meta.engines !== undefined) {
    if (
      !meta.engines ||
      Array.isArray(meta.engines) ||
      typeof meta.engines !== "object" ||
      Object.entries(meta.engines).some(
        ([key, value]) => !/^[a-z]+$/.test(key) || typeof value !== "string" || value.length > 128,
      )
    )
      throw new Error("Invalid dependency engine metadata");
    fields.engines = { ...meta.engines };
  }
  return fields;
}

/** Deterministic projection of this release's runtime graph. This does not install dependencies. */
export function projectRuntimeDependencies({ lock, version, sharpVersion, metadata = {} }) {
  runtimeBuildOptions(version);
  if (String(lock.lockfileVersion) !== "9.0") throw new Error("Unsupported pnpm lock format");
  const sharp = own(own(lock.importers, "apps/daemon").dependencies, "sharp");
  if (sharp.specifier !== sharpVersion || versionOf(sharp.version) !== sharpVersion)
    throw new Error("Sharp package and lock pins disagree");
  const sharpSnapshot = own(lock.snapshots, `sharp@${sharp.version}`);
  const roots = { sharp: sharp.version };
  for (const name of NATIVE) {
    roots[name] = own(sharpSnapshot.optionalDependencies, name);
    const meta = own(lock.packages, `${name}@${versionOf(roots[name])}`);
    if (JSON.stringify(meta.os) !== '["darwin"]' || JSON.stringify(meta.cpu) !== '["arm64"]')
      throw new Error("Required native package is not Darwin arm64");
  }
  const queue = Object.entries(roots).map(([name, reference]) => ({
    name,
    reference,
    optional: false,
  }));
  const graph = new Map(),
    visited = new Set();
  while (queue.length) {
    const { name, reference, optional } = queue.shift();
    if (!NAME.test(name) || name.length > 214) throw new Error("Invalid runtime dependency name");
    const baseVersion = versionOf(reference),
      key = `${name}@${reference}`;
    const visit = `${key}:${optional}`;
    if (visited.has(visit)) continue;
    visited.add(visit);
    if (visited.size > 256) throw new Error("Runtime graph exceeds limit");
    const meta = own(lock.packages, `${name}@${baseVersion}`),
      snapshot = own(lock.snapshots, key);
    const resolved = `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${baseVersion}.tgz`;
    const integrity = meta.resolution?.integrity;
    if (
      typeof integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) ||
      Object.keys(meta.resolution).some((key) => !["integrity", "tarball"].includes(key)) ||
      (meta.resolution.tarball !== undefined && meta.resolution.tarball !== resolved)
    )
      throw new Error("Unsupported runtime dependency resolution");
    const item = { version: baseVersion, resolved, integrity, ...platformFields(meta) };
    const extra = metadata[name];
    if (extra && (extra.name !== name || extra.version !== baseVersion))
      throw new Error("Installed dependency metadata does not match the lock");
    if (extra?.license) item.license = extra.license;
    if (meta.hasBin) {
      const bin = extra?.bin;
      if (
        !bin ||
        typeof bin !== "object" ||
        Array.isArray(bin) ||
        Object.entries(bin).some(
          ([name, path]) =>
            !/^[a-z0-9_-]+$/.test(name) ||
            typeof path !== "string" ||
            !/^[A-Za-z0-9_./-]+$/.test(path) ||
            path.startsWith("/") ||
            path.split("/").includes(".."),
        )
      )
        throw new Error("Missing or invalid locked executable metadata");
      item.bin = { ...bin };
    }
    if (HOOKS.some((hook) => extra?.scripts?.[hook])) item.hasInstallScript = true;
    for (const group of ["dependencies", "optionalDependencies"]) {
      const entries = [];
      for (const [child, childReference] of Object.entries(snapshot[group] ?? {})) {
        if (
          child === "@types/node" &&
          name === "sharp" &&
          group === "optionalDependencies" &&
          meta.peerDependenciesMeta?.[child]?.optional === true
        )
          continue;
        entries.push([child, versionOf(childReference)]);
        queue.push({
          name: child,
          reference: childReference,
          optional: optional || group === "optionalDependencies",
        });
      }
      if (entries.length) item[group] = ordered(entries);
    }
    if (meta.peerDependencies) {
      for (const peer of Object.keys(meta.peerDependencies))
        if (
          name !== "sharp" ||
          peer !== "@types/node" ||
          meta.peerDependenciesMeta?.[peer]?.optional !== true
        )
          throw new Error("Unreviewed runtime peer dependency");
      item.peerDependencies = { ...meta.peerDependencies };
      item.peerDependenciesMeta = { ...meta.peerDependenciesMeta };
    }
    const existing = graph.get(name);
    if (existing && JSON.stringify(existing.item) !== JSON.stringify(item))
      throw new Error("Conflicting runtime dependency versions or contexts");
    graph.set(name, { item, optional: existing ? existing.optional && optional : optional });
  }
  const dependencies = ordered(Object.entries(roots).map(([name, ref]) => [name, versionOf(ref)]));
  const packageJson = {
    name: "localdot",
    version,
    private: true,
    type: "module",
    description: "A local computer agent",
    bin: { localdot: "bin/localdot.mjs" },
    files: [
      "bin/",
      "dist/",
      "web/",
      "skills/",
      "release.json",
      "THIRD-PARTY.md",
      "npm-shrinkwrap.json",
    ],
    engines: { node: ">=24" },
    os: ["darwin"],
    cpu: ["arm64"],
    dependencies,
  };
  const packages = {
    "": {
      name: packageJson.name,
      version,
      bin: packageJson.bin,
      engines: packageJson.engines,
      os: packageJson.os,
      cpu: packageJson.cpu,
      dependencies,
    },
    ...ordered(
      [...graph].map(([name, { item, optional }]) => [
        `node_modules/${name}`,
        { ...item, ...(optional ? { optional: true } : {}) },
      ]),
    ),
  };
  return {
    packageJson,
    shrinkwrap: { name: packageJson.name, version, lockfileVersion: 3, requires: true, packages },
    graph: [...graph]
      .map(([name, value]) => ({ name, version: value.item.version, optional: value.optional }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Build-time YAML parsing only; the published app does not need Ruby or a YAML parser. */
export function readPnpmLock(bytes) {
  if (bytes.length > 4 * 1024 * 1024) throw new Error("Workspace lock is too large");
  const text = execFileSync(
    "ruby",
    [
      "--disable-gems",
      "-rjson",
      "-ryaml",
      "-e",
      "puts JSON.generate(YAML.safe_load(STDIN.read, permitted_classes: [], permitted_symbols: [], aliases: false))",
    ],
    {
      input: bytes,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { PATH: process.env.PATH, RUBYOPT: "", RUBYLIB: "" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return JSON.parse(text);
}

export async function writeRuntimeDependencies({ output, version }) {
  const bytes = await readFile(join(WORKSPACE, "pnpm-lock.yaml")),
    lock = readPnpmLock(bytes);
  const daemon = JSON.parse(await readFile(join(WORKSPACE, "apps/daemon/package.json"), "utf8"));
  const sharpRoot = await realpath(join(WORKSPACE, "apps/daemon/node_modules/sharp"));
  const requireSharp = createRequire(join(sharpRoot, "package.json"));
  const metadata = {
    sharp: JSON.parse(await readFile(join(sharpRoot, "package.json"), "utf8")),
    semver: JSON.parse(await readFile(requireSharp.resolve("semver/package.json"), "utf8")),
  };
  const result = projectRuntimeDependencies({
    lock,
    version,
    sharpVersion: daemon.dependencies.sharp,
    metadata,
  });
  for (const [name, data] of [
    ["package.json", result.packageJson],
    ["npm-shrinkwrap.json", result.shrinkwrap],
  ])
    await writeFile(join(output, name), `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
  return {
    workspaceLockSHA256: createHash("sha256").update(bytes).digest("hex"),
    dependencies: result.packageJson.dependencies,
    graph: result.graph,
    actualArchivesVerified: false,
    cleanInstallVerified: false,
  };
}
