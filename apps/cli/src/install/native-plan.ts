import { RELEASE_VERSION } from "../../../../packages/protocol/src/release.ts";

export const NATIVE_ROOTS = [
  "sharp",
  "@img/sharp-darwin-arm64",
  "@img/sharp-libvips-darwin-arm64",
] as const;
export interface NativePackage {
  name: string;
  version: string;
  resolved: string;
  integrity: string;
  sha512: string;
  dependencies: Readonly<Record<string, string>>;
  optionalDependencies: Readonly<Record<string, string>>;
}
const fail = () => new Error("Native dependency lock is invalid or unsupported.");
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
}
function exact(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !VERSION.test(value)) throw fail();
  return value;
}
/** Reconstruct the only permitted archive location; callers cannot supply an alternate origin. */
export function nativeArchiveURL(name: string, version: string): URL {
  if (typeof name !== "string" || name.length > 214 || !NAME.test(name)) throw fail();
  const v = exact(version);
  return new URL(`https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${v}.tgz`);
}
function dependencies(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const map = record(value);
  if (Object.keys(map).length > 128) throw fail();
  return Object.freeze(
    Object.fromEntries(
      Object.entries(map).map(([name, version]) => {
        if (name.length > 214 || !NAME.test(name)) throw fail();
        return [name, exact(version)];
      }),
    ),
  );
}
function platform(value: unknown, current: string): boolean {
  if (value === undefined) return true;
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 16 ||
    value.some((v) => typeof v !== "string" || !/^!?[a-z0-9_-]+$/.test(v))
  )
    throw fail();
  if (value.includes(`!${current}`)) return false;
  const positives = value.filter((v) => !v.startsWith("!"));
  return !positives.length || positives.includes(current) || positives.includes("any");
}

/** Inputs must be read from the verified app package. Never use ambient npm configuration or
 * metadata to resolve a version. The authenticated lock fully determines this flat module graph.
 */
export function nativeDependencyPlan(
  packageJSON: string,
  lockJSON: string,
  version: string,
): ReadonlyArray<NativePackage> {
  try {
    if (
      !RELEASE_VERSION.test(version) ||
      version.length > 64 ||
      Buffer.byteLength(packageJSON) > 1024 * 1024 ||
      Buffer.byteLength(lockJSON) > 4 * 1024 * 1024
    )
      throw fail();
    const pkg = record(JSON.parse(packageJSON)),
      lock = record(JSON.parse(lockJSON)),
      packages = record(lock.packages),
      root = record(packages[""]);
    if (
      pkg.name !== "localdot" ||
      pkg.version !== version ||
      lock.name !== pkg.name ||
      lock.version !== version ||
      lock.lockfileVersion !== 3 ||
      lock.requires !== true ||
      root.name !== pkg.name ||
      root.version !== version ||
      [
        "scripts",
        "optionalDependencies",
        "devDependencies",
        "peerDependencies",
        "overrides",
        "workspaces",
        "bundledDependencies",
        "bundleDependencies",
      ].some((k) => k in pkg) ||
      Object.keys(lock).some(
        (k) => !["name", "version", "lockfileVersion", "requires", "packages"].includes(k),
      ) ||
      Object.keys(packages).length > 129
    )
      throw fail();
    const roots = dependencies(pkg.dependencies),
      lockedRoots = dependencies(root.dependencies);
    if (
      JSON.stringify(Object.entries(roots).sort()) !==
        JSON.stringify(Object.entries(lockedRoots).sort()) ||
      Object.keys(roots).length !== NATIVE_ROOTS.length ||
      NATIVE_ROOTS.some((name) => !roots[name])
    )
      throw fail();
    const all = new Map<string, NativePackage & { supported: boolean; optional: boolean }>();
    for (const [path, input] of Object.entries(packages)) {
      if (path === "") continue;
      const name = path.slice("node_modules/".length),
        item = record(input);
      if (
        !path.startsWith("node_modules/") ||
        !NAME.test(name) ||
        name.length > 214 ||
        Object.keys(item).some(
          (k) =>
            ![
              "version",
              "resolved",
              "integrity",
              "os",
              "cpu",
              "libc",
              "engines",
              "license",
              "dependencies",
              "optionalDependencies",
              "optional",
              "hasInstallScript",
              "bin",
              "peerDependencies",
              "peerDependenciesMeta",
            ].includes(k),
        ) ||
        (item.optional !== undefined && typeof item.optional !== "boolean") ||
        (item.hasInstallScript !== undefined && typeof item.hasInstallScript !== "boolean")
      )
        throw fail();
      const v = exact(item.version),
        resolved = nativeArchiveURL(name, v).href;
      // Sharp's optional TypeScript declarations are not a runtime edge. No other ambient peer
      // resolution is allowed by this installer; new peer requirements need an explicit policy.
      if (item.peerDependencies !== undefined || item.peerDependenciesMeta !== undefined) {
        if (
          name !== "sharp" ||
          JSON.stringify(item.peerDependencies) !== '{"@types/node":"*"}' ||
          JSON.stringify(item.peerDependenciesMeta) !== '{"@types/node":{"optional":true}}'
        )
          throw fail();
      }
      if (
        item.resolved !== resolved ||
        typeof item.integrity !== "string" ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity)
      )
        throw fail();
      const hash = Buffer.from(item.integrity.slice(7), "base64");
      if (hash.length !== 64 || `sha512-${hash.toString("base64")}` !== item.integrity)
        throw fail();
      // Validate all platform arrays even when an earlier field already rules the package out.
      const os = platform(item.os, "darwin"),
        cpu = platform(item.cpu, "arm64"),
        libc = platform(item.libc, "none");
      all.set(name, {
        name,
        version: v,
        resolved,
        integrity: item.integrity,
        sha512: hash.toString("hex"),
        dependencies: dependencies(item.dependencies),
        optionalDependencies: dependencies(item.optionalDependencies),
        supported: os && cpu && libc,
        optional: item.optional === true,
      });
    }
    for (const item of all.values())
      for (const [name, v] of Object.entries({
        ...item.optionalDependencies,
        ...item.dependencies,
      })) {
        if (all.get(name)?.version !== v) throw fail();
        if (
          item.dependencies[name] &&
          item.optionalDependencies[name] &&
          item.dependencies[name] !== item.optionalDependencies[name]
        )
          throw fail();
      }
    const chosen = new Map<string, NativePackage>(),
      queue = Object.entries(roots).map(([name, v]) => ({ name, v, required: true }));
    while (queue.length) {
      const next = queue.shift();
      if (!next) break;
      const item = all.get(next.name);
      if (!item || item.version !== next.v) throw fail();
      if (!item.supported) {
        if (next.required) throw fail();
        continue;
      }
      if (chosen.has(item.name)) continue;
      const { supported: _supported, optional: _optional, ...selected } = item;
      chosen.set(item.name, Object.freeze(selected));
      for (const [name, v] of Object.entries(item.dependencies))
        queue.push({ name, v, required: true });
      for (const [name, v] of Object.entries(item.optionalDependencies))
        queue.push({ name, v, required: false });
    }
    // Unreachable mandatory packages indicate an incomplete/ambiguous projected graph.
    for (const item of all.values()) if (!item.optional && !chosen.has(item.name)) throw fail();
    return Object.freeze([...chosen.values()].sort((a, b) => a.name.localeCompare(b.name)));
  } catch {
    throw fail();
  }
}
