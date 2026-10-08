import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { assertRuntimeImports, runtimeBuildOptions, WORKSPACE } from "./build-options.mjs";
import { verifySandboxArchive } from "./sandbox-integrity.mjs";

export const SANDBOX_VERSION = "0.0.78";
export const SANDBOX_DIRECTORY = "dist/sandbox-runtime";
export const SANDBOX_ENTRY = `${SANDBOX_DIRECTORY}/dist/cli.mjs`;
export const JAVA_AGENT = "vendor/java-proxy-agent/srt-proxy-agent.jar";
const PATCH = `patches/sandbox-runtime-${SANDBOX_VERSION}.patch`;
const NAME = "@anthropic-ai/sandbox-runtime";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function inputFile(root, path) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*$/.test(path) || path.includes(".."))
    throw new Error("Invalid sandbox input path");
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const st = await lstat(join(root, ...parts.slice(0, i)));
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Linked sandbox input");
  }
  const file = join(root, path),
    st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 16 * 1024 * 1024)
    throw new Error("Invalid sandbox input file");
  return readFile(file);
}

/** Check every post-image hunk, not just the presence of the loopback setting's name.
 * This confirms the local patch is present; it does NOT establish registry provenance.
 */
export async function checkSandboxPatch(root, patch) {
  const lines = patch.toString("utf8").split("\n"),
    files = new Map();
  let path,
    hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("+++ b/")) path = lines[i].slice(6);
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    if (!match) continue;
    if (!path) throw new Error("Missing sandbox patch target");
    if (!files.has(path)) files.set(path, await inputFile(root, path));
    const actual = files.get(path).toString("utf8").split("\n"),
      expected = [];
    for (i++; i < lines.length && /^[ +\-\\]/.test(lines[i]); i++) {
      if (lines[i].startsWith("+") || lines[i].startsWith(" ")) expected.push(lines[i].slice(1));
    }
    i--;
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (
      expected.length !== count ||
      expected.some((line, n) => actual[Number(match[1]) - 1 + n] !== line)
    )
      throw new Error("Installed sandbox does not contain the exact local patch");
    hunks++;
  }
  if (hunks === 0) throw new Error("Empty sandbox patch");
  return {
    hunks,
    files: Object.fromEntries([...files].map(([path, bytes]) => [path, sha256(bytes)])),
  };
}

export function installedSandboxRoot() {
  const requireCodex = createRequire(join(WORKSPACE, "harness/codex/package.json"));
  return dirname(requireCodex.resolve(`${NAME}/package.json`));
}

/** Build the patched Mac runtime from local build inputs. Never starts a sandbox or a service. */
export async function buildSandbox({
  output,
  version,
  source = installedSandboxRoot(),
  upstreamArchive,
}) {
  const metadata = JSON.parse((await inputFile(source, "package.json")).toString("utf8"));
  if (metadata.name !== NAME || metadata.version !== SANDBOX_VERSION)
    throw new Error("Unexpected sandbox dependency version");
  const patch = await readFile(join(WORKSPACE, PATCH)),
    patchSHA256 = sha256(patch),
    lock = await readFile(join(WORKSPACE, "pnpm-lock.yaml"), "utf8");
  if (!lock.includes(`'${NAME}@${SANDBOX_VERSION}':\n    hash: ${patchSHA256}\n`))
    throw new Error("Sandbox patch does not match the workspace lock");
  const patchCheck = await checkSandboxPatch(source, patch);
  const resolution =
    /^ {2}'@anthropic-ai\/sandbox-runtime@0\.0\.78':\n {4}resolution: \{integrity: (sha512-[^}]+)\}/m.exec(
      lock,
    );
  if (!resolution) throw new Error("Missing upstream sandbox integrity pin");
  const archiveVerification = upstreamArchive
    ? await verifySandboxArchive({
        archive: upstreamArchive,
        expectedIntegrity: resolution[1],
        source,
        patch,
        readSource: inputFile,
      })
    : undefined;
  const root = join(output, SANDBOX_DIRECTORY);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { mode: 0o700 });
  const result = await build({
    ...runtimeBuildOptions(version),
    entryPoints: [join(source, "dist/cli.js")],
    outfile: join(output, SANDBOX_ENTRY),
  });
  assertRuntimeImports(result.metafile);
  // cli.js reads ../package.json; the original Java resolver also handles this bundle layout.
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: NAME, version: SANDBOX_VERSION, type: "module", license: metadata.license }, null, 2)}\n`,
    { flag: "wx" },
  );
  const jar = await inputFile(source, JAVA_AGENT);
  await mkdir(dirname(join(root, JAVA_AGENT)), { recursive: true });
  await writeFile(join(root, JAVA_AGENT), jar, { flag: "wx" });
  await writeFile(join(root, "LICENSE"), await inputFile(source, "LICENSE"), { flag: "wx" });
  await writeFile(join(root, "PATCH.txt"), patch, { flag: "wx" });
  await writeFile(
    join(root, "NOTICE.md"),
    `# Modified sandbox runtime\n\n${NAME} ${SANDBOX_VERSION}, Copyright Anthropic PBC.\n` +
      "The accompanying LICENSE applies. localDot applies the included PATCH.txt to restrict\n" +
      "native loopback binding and compiles the JavaScript dependency graph into dist/cli.mjs.\n" +
      `Patch SHA-256: ${patchSHA256}\n\n` +
      "This payload targets macOS on Apple Silicon. The upstream Java proxy agent is unchanged.\n" +
      "Linux/Windows sandbox executables are not part of the supported local host runtime.\n",
    { flag: "wx" },
  );
  return {
    name: NAME,
    version: SANDBOX_VERSION,
    entry: SANDBOX_ENTRY,
    patchSHA256,
    patchCheck,
    javaAgentSHA256: sha256(jar),
    inputs: Object.keys(result.metafile.inputs),
    metafile: result.metafile,
    upstreamArchiveVerified: Boolean(archiveVerification),
    ...(archiveVerification ? { archiveVerification } : {}),
  };
}
