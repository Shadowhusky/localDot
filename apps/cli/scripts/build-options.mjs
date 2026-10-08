import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKSPACE = fileURLToPath(new URL("../../..", import.meta.url));

/** A packaged bundle cannot depend on arbitrary modules found in a developer's installation. */
export function assertRuntimeImports(metafile, allowed = []) {
  for (const output of Object.values(metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !isBuiltin(dependency.path) && !allowed.includes(dependency.path))
        throw new Error(`Unexpected external runtime dependency: ${dependency.path}`);
    }
  }
}

/** Resolve workspace packages to this candidate, not an installed link to another checkout. */
export function workspaceAliases() {
  const aliases = {
    "supports-color": join(WORKSPACE, "apps/cli/src/install/no-debug-color.cjs"),
  };
  for (const path of [
    "packages/protocol",
    "packages/providers",
    "packages/stage",
    "harness/codex",
  ]) {
    const dir = join(WORKSPACE, path);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const [key, target] of Object.entries(pkg.exports)) {
      if (typeof target !== "string") throw new Error("Unsupported workspace export");
      aliases[pkg.name + (key === "." ? "" : key.slice(1))] = join(dir, target);
    }
  }
  // Vite's alias plugin selects the first matching prefix; subpath exports must come first.
  return Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => b.length - a.length));
}

export function runtimeBuildOptions(version) {
  if (
    typeof version !== "string" ||
    version.length > 64 ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?$/.test(version)
  ) {
    throw new Error("A release version is required");
  }
  return {
    absWorkingDir: WORKSPACE,
    alias: workspaceAliases(),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    sourcemap: false,
    // esbuild's source annotations can expose a linked dependency's absolute checkout path.
    minifyWhitespace: true,
    minifyIdentifiers: true,
    keepNames: true,
    legalComments: "inline",
    logLevel: "silent",
    metafile: true,
    define: {
      __LOCALDOT_VERSION__: JSON.stringify(version),
      __LOCALDOT_PACKAGED__: "true",
      // ws has complete JavaScript / Node-buffer implementations. Avoid optional native addon
      // discovery so a packaged build does not execute an ambient, unpinned dependency.
      "process.env.WS_NO_BUFFER_UTIL": '"1"',
      "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
    },
    banner: {
      js: 'import { createRequire as __localdotCreateRequire } from "node:module"; const require = __localdotCreateRequire(import.meta.url);',
    },
  };
}
