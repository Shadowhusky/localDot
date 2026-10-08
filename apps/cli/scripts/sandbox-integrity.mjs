import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNPACK = fileURLToPath(new URL("../../../scripts/unpack-audit.py", import.meta.url));
const PATH = /^dist\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:js|d\.ts)$/;
const textLines = (bytes) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes).match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Apply the checked-in unified patch exactly in memory; no fuzzy matching or shell patch command. */
export function patchedSandboxFiles(originals, patch) {
  const lines = textLines(patch),
    output = new Map();
  let path, beforeMissing, original, cursor, result, hunks;
  const finish = () => {
    if (!path) return;
    if (!hunks) throw new Error("Patch target has no hunks");
    output.set(path, Buffer.from([...result, ...original.slice(cursor)].join("")));
    path = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      finish();
      beforeMissing = undefined;
      continue;
    }
    if (line.startsWith("--- ")) {
      const name = line.slice(4).trimEnd();
      beforeMissing = name === "/dev/null";
      if (!beforeMissing && !name.startsWith("a/dist/")) throw new Error("Invalid patch source");
      path = beforeMissing ? undefined : name.slice(2);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const name = line.slice(4).trimEnd();
      if (!name.startsWith("b/") || beforeMissing === undefined)
        throw new Error("Invalid patch destination");
      const target = name.slice(2);
      if (
        !PATH.test(target) ||
        target.includes("..") ||
        (path && path !== target) ||
        output.has(target)
      )
        throw new Error("Invalid patch target");
      path = target;
      if (beforeMissing ? originals.has(path) : !originals.has(path))
        throw new Error("Patch source existence mismatch");
      original = beforeMissing ? [] : textLines(originals.get(path));
      cursor = 0;
      result = [];
      hunks = 0;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) {
      if (line.startsWith("@@") || line.startsWith("\\")) throw new Error("Unsupported patch hunk");
      continue;
    }
    if (!path || !original) throw new Error("Missing patch file header");
    const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]),
      newCount = hunk[4] === undefined ? 1 : Number(hunk[4]),
      start = oldCount === 0 ? Number(hunk[1]) : Number(hunk[1]) - 1,
      before = [],
      after = [];
    for (i++; i < lines.length && /^[ +\-\\]/.test(lines[i]); i++) {
      if (lines[i].startsWith("\\")) throw new Error("Nonterminated patch lines unsupported");
      if (lines[i].startsWith("-") || lines[i].startsWith(" ")) before.push(lines[i].slice(1));
      if (lines[i].startsWith("+") || lines[i].startsWith(" ")) after.push(lines[i].slice(1));
    }
    i--;
    if (
      start < cursor ||
      start > original.length ||
      before.length !== oldCount ||
      after.length !== newCount ||
      before.some((value, n) => original[start + n] !== value)
    )
      throw new Error("Patch does not match pristine source");
    result.push(...original.slice(cursor, start));
    if ((newCount === 0 ? Number(hunk[3]) : Number(hunk[3]) - 1) !== result.length)
      throw new Error("Patch output position mismatch");
    result.push(...after);
    cursor = start + oldCount;
    hunks++;
  }
  finish();
  if (!output.size) throw new Error("No patch files");
  return output;
}

async function runtimeScripts(root, prefix = "dist") {
  const paths = [];
  for (const name of await readdir(join(root, prefix))) {
    const path = `${prefix}/${name}`,
      stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) throw new Error("Linked sandbox source");
    if (stat.isDirectory()) paths.push(...(await runtimeScripts(root, path)));
    else if (path.endsWith(".js")) paths.push(path);
  }
  return paths.sort();
}

/** Verify the local patched package against a supplied pristine archive and lockfile SRI.
 * Network retrieval is deliberately separate. This function cannot fetch another archive.
 */
export async function verifySandboxArchive({
  archive,
  expectedIntegrity,
  source,
  patch,
  readSource,
}) {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(expectedIntegrity))
    throw new Error("Invalid sandbox integrity pin");
  const temporary = await mkdtemp(join(tmpdir(), "localdot-sandbox-verification-"));
  try {
    const result = JSON.parse(
      execFileSync("python3", ["-I", "-S", UNPACK, resolve(archive), temporary], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    if (result.integrity !== expectedIntegrity)
      throw new Error("Sandbox archive integrity mismatch");
    const originals = new Map();
    for (const file of result.files) {
      if (
        file.path.startsWith("dist/") ||
        ["package.json", "LICENSE", "vendor/java-proxy-agent/srt-proxy-agent.jar"].includes(
          file.path,
        )
      )
        originals.set(file.path, await readFile(join(temporary, "tree", file.path)));
    }
    const metadata = JSON.parse(originals.get("package.json").toString("utf8"));
    if (metadata.name !== "@anthropic-ai/sandbox-runtime" || metadata.version !== "0.0.78")
      throw new Error("Unexpected sandbox archive identity");
    const patched = patchedSandboxFiles(originals, patch),
      expected = new Map([...originals, ...patched]);
    const paths = [...expected.keys()]
      .filter(
        (path) =>
          (path.startsWith("dist/") && path.endsWith(".js")) ||
          patched.has(path) ||
          ["package.json", "LICENSE", "vendor/java-proxy-agent/srt-proxy-agent.jar"].includes(path),
      )
      .sort();
    for (const required of [
      "package.json",
      "LICENSE",
      "dist/cli.js",
      "vendor/java-proxy-agent/srt-proxy-agent.jar",
    ])
      if (!expected.has(required)) throw new Error("Sandbox archive asset is missing");
    for (const path of paths) {
      const actual = await readSource(source, path);
      if (!actual.equals(expected.get(path)))
        throw new Error("Sandbox source differs from pinned archive and patch");
    }
    const scripts = paths.filter((path) => path.startsWith("dist/") && path.endsWith(".js"));
    if (JSON.stringify(await runtimeScripts(source)) !== JSON.stringify(scripts))
      throw new Error("Unexpected sandbox runtime source file");
    return { integrity: result.integrity, checkedFiles: paths.length, patchedFiles: patched.size };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
