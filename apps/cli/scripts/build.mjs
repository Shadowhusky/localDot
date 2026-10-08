import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertRuntimeImports, runtimeBuildOptions, WORKSPACE } from "./build-options.mjs";
import { DIAGNOSTIC_ASSETS } from "./diagnostic-assets.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Build operational CLI output. Full release assembly and verification are separate gates. */
export async function buildCli({ output, version }) {
  const options = runtimeBuildOptions(version);
  const out = resolve(output);
  await mkdir(join(out, "bin"), { recursive: true });
  const result = await build({
    ...options,
    entryPoints: {
      cli: join(ROOT, "src/main.ts"),
      "release-verification-worker": join(ROOT, "src/install/release-verification-worker.ts"),
    },
    outdir: join(out, "dist"),
    outExtension: { ".js": ".mjs" },
  });
  assertRuntimeImports(result.metafile);
  for (const [source, target] of Object.entries(DIAGNOSTIC_ASSETS))
    await copyFile(join(WORKSPACE, source), join(out, target));
  await copyFile(join(ROOT, "bin/localdot.mjs"), join(out, "bin/localdot.mjs"));
  await chmod(join(out, "bin/localdot.mjs"), 0o755);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, version, ...extra] = process.argv.slice(2);
  if (!output || !version || extra.length) {
    console.error("Usage: build.mjs <output-directory> <version>");
    process.exitCode = 2;
  } else {
    try {
      await buildCli({ output, version });
    } catch {
      console.error("CLI build failed.");
      process.exitCode = 1;
    }
  }
}
