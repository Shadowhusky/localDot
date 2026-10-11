import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { RULES } from "../../../scripts/check-hygiene.mjs";
import { MAX_FILE_BYTES, PACK_ALLOWLIST, PACK_RULES } from "../../../scripts/check-pack.mjs";
import { buildMacNotifier } from "../../web/scripts/mac-notifier.mjs";
import { writeNotices } from "../../web/scripts/notices.mjs";
import { assertRuntimeImports, runtimeBuildOptions, WORKSPACE } from "./build-options.mjs";
import { DIAGNOSTIC_ASSETS } from "./diagnostic-assets.mjs";
import { writeDependencyNotices } from "./licenses.mjs";
import { writeRuntimeDependencies } from "./runtime-dependencies.mjs";
import { buildSandbox } from "./sandbox-runtime.mjs";

const EXTERNAL = ["sharp"];
const ASSETS = {
  ...DIAGNOSTIC_ASSETS,
  "apps/daemon/src/cells/browser-seccomp.json": "dist/browser-seccomp.json",
  "skills/office-files/SKILL.md": "skills/office-files/SKILL.md",
  "apps/cli/bin/localdot.mjs": "bin/localdot.mjs",
};

async function filesIn(dir, prefix = "") {
  const files = [];
  for (const name of (await readdir(join(dir, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const st = await lstat(join(dir, relative));
    if (st.isSymbolicLink()) throw new Error("Build input contains a link");
    if (st.isDirectory()) files.push(...(await filesIn(dir, relative)));
    else if (st.isFile() && st.nlink === 1 && st.size <= MAX_FILE_BYTES) files.push(relative);
    else throw new Error("Unsupported build input");
  }
  return files;
}

async function copyAsset(source, destination) {
  const st = await lstat(source);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > MAX_FILE_BYTES)
    throw new Error("Invalid runtime asset");
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

/** Assemble the real runtime payload. Metadata/dependency verification and publishing stay separate. */
export async function buildRuntime({
  output,
  version,
  sandboxArchive,
  target = `${process.platform}-${process.arch}`,
}) {
  const options = runtimeBuildOptions(version);
  const out = resolve(output);
  // An existing directory may contain a user's files or an earlier artifact. Never merge into it.
  await mkdir(out, { mode: 0o700 });
  const runtimeDependencyLock = await writeRuntimeDependencies({ output: out, version, target });
  const sandbox = await buildSandbox({ output: out, version, upstreamArchive: sandboxArchive });
  const result = await build({
    ...options,
    entryPoints: {
      cli: join(WORKSPACE, "apps/cli/src/main.ts"),
      daemon: join(WORKSPACE, "apps/daemon/src/main.ts"),
      "quiet-page-worker": join(WORKSPACE, "apps/daemon/src/deliverables/quiet-page-worker.ts"),
      "release-verification-worker": join(
        WORKSPACE,
        "apps/cli/src/install/release-verification-worker.ts",
      ),
    },
    outdir: join(out, "dist"),
    outExtension: { ".js": ".mjs" },
    external: EXTERNAL,
  });
  assertRuntimeImports(result.metafile, EXTERNAL);
  for (const [source, target] of Object.entries(ASSETS))
    await copyAsset(join(WORKSPACE, source), join(out, target));
  await chmod(join(out, "bin/localdot.mjs"), 0o755);
  const vendor = join(WORKSPACE, "apps/web/vendor/selkies");
  for (const path of await filesIn(vendor)) {
    const target = `web/vendor/selkies/${path}`;
    if (!PACK_ALLOWLIST.some((pattern) => pattern.test(target)))
      throw new Error("Unsupported vendor asset");
    await copyAsset(join(vendor, path), join(out, target));
  }
  const webDir = join(WORKSPACE, "apps/web"),
    webOut = join(out, "web/dist");
  const requireWeb = createRequire(join(webDir, "package.json"));
  const vite = await import(pathToFileURL(requireWeb.resolve("vite")).href);
  const webModules = new Set();
  const collectModules = () => ({
    name: "localdot-bundled-license-inventory",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === "chunk") for (const id of Object.keys(chunk.modules)) webModules.add(id);
      }
    },
  });
  await vite.build({
    root: webDir,
    configFile: join(webDir, "vite.config.ts"),
    configLoader: "native",
    logLevel: "warn",
    resolve: { alias: options.alias },
    plugins: [collectModules()],
    worker: { plugins: () => [collectModules()] },
    build: { outDir: webOut, emptyOutDir: false, sourcemap: false },
  });
  if (target.startsWith("darwin-")) buildMacNotifier(webDir, webOut);
  const dependencyNotices = await writeDependencyNotices({
    inputs: [...Object.keys(result.metafile.inputs), ...sandbox.inputs, ...webModules],
    workspace: WORKSPACE,
    outDir: join(webOut, "assets/licenses"),
  });
  // Replace only the generic mediabunny notice with its full source-location notice. The same
  // installed license bytes remain included; other generated notices are never overwritten.
  writeNotices({ webDir, outDir: join(webOut, "assets") });

  const files = [];
  for (const path of await filesIn(out)) {
    if (!PACK_ALLOWLIST.some((pattern) => pattern.test(path)))
      throw new Error(`Unexpected runtime output: ${path}`);
    const bytes = await readFile(join(out, path));
    for (const { name, pattern } of [...RULES, ...PACK_RULES]) {
      if (
        new RegExp(pattern.source, pattern.flags).test(path) ||
        new RegExp(pattern.source, pattern.flags).test(bytes.toString("utf8"))
      )
        throw new Error(`Runtime payload violates ${name}`);
    }
    files.push({
      path,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const daemon = JSON.parse(await readFile(join(WORKSPACE, "apps/daemon/package.json"), "utf8"));
  return {
    output: out,
    version,
    files,
    runtimeDependencies: {
      sharp: daemon.dependencies.sharp,
    },
    runtimeDependencyLock,
    sandbox,
    sandboxPatchSHA256: sandbox.patchSHA256,
    dependencyNotices,
    webModuleCount: webModules.size,
    metafile: result.metafile,
    completeRelease: false,
    pending: [
      "verified external image-processing dependencies",
      ...(!sandbox.upstreamArchiveVerified ? ["sandbox upstream archive verification"] : []),
      "release metadata, provenance and signed keyd",
      "installer and service lifecycle",
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, version, receipt, sandboxArchive, ...extra] = process.argv.slice(2);
  if (!output || !version || !receipt || extra.length) {
    console.error(
      "Usage: build-runtime.mjs <new-output-directory> <version> <receipt.json> [pinned-sandbox.tgz]",
    );
    process.exitCode = 2;
  } else {
    try {
      const receiptRelative = relative(resolve(output), resolve(receipt));
      if (
        !isAbsolute(receiptRelative) &&
        receiptRelative !== ".." &&
        !receiptRelative.startsWith(`..${sep}`)
      )
        throw new Error("Build receipt must be outside the payload");
      const result = await buildRuntime({ output, version, sandboxArchive });
      await writeFile(receipt, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch {
      console.error("Runtime build failed. Partial output is not a release package.");
      process.exitCode = 1;
    }
  }
}
