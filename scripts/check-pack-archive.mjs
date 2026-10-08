import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "./check-hygiene.mjs";
import { checkPack, PACK_RULES } from "./check-pack.mjs";

const UNPACK = fileURLToPath(new URL("./unpack-audit.py", import.meta.url));

/** Audits actual archive bytes in a disposable, private tree. This build tool is not shipped. */
export function checkPackArchive(
  archive,
  { rules = [...RULES, ...PACK_RULES], temporaryParent = tmpdir() } = {},
) {
  let root;
  try {
    root = mkdtempSync(join(temporaryParent, "localdot-archive-check-"));
    const text = execFileSync("python3", ["-I", "-S", UNPACK, resolve(archive), root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const result = JSON.parse(text);
    if (!Array.isArray(result.files) || typeof result.integrity !== "string")
      throw new Error("invalid audit result");
    const problems = checkPack(join(root, "tree"), { files: result.files, rules });
    const launcher = result.files.find((file) => file.path === "bin/localdot.mjs");
    if (launcher && !(launcher.mode & 0o100))
      problems.push("bin/localdot.mjs: launcher is not executable");
    const metadata = readFileSync(join(root, "metadata.bin")).toString("utf8");
    for (const { name, pattern } of rules) {
      if (new RegExp(pattern.source, pattern.flags).test(metadata))
        problems.push(`archive metadata: ${name}`);
    }
    return { problems, integrity: result.integrity, files: result.files };
  } catch {
    return { problems: ["archive could not be verified"] };
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const archive = process.argv[2];
  if (!archive) {
    console.error("Usage: check-pack-archive <package.tgz>");
    process.exitCode = 2;
  } else {
    const result = checkPackArchive(archive);
    for (const problem of result.problems) console.error(`pack: ${problem}`);
    process.exitCode = result.problems.length ? 1 : 0;
  }
}
