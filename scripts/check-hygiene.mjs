import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ALLOWLIST = new Set(["scripts/check-hygiene.mjs"]);

export const RULES = [
  {
    name: "private theme name",
    pattern: /kurisu|makise|amadeus|steins\s*;?\s*gate|牧瀬|紅莉栖|アマデウス/i,
  },
  { name: "OpenAI-style key", pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: "Slack token", pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { name: "Telegram bot token", pattern: /\b\d{8,10}:AA[0-9A-Za-z_-]{30,}\b/ },
  { name: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
];

export function findViolations(files, readText) {
  const violations = [];
  for (const file of files) {
    if (ALLOWLIST.has(file)) continue;
    if (RULES[0].pattern.test(file)) {
      violations.push({ file, rule: RULES[0].name, where: "path" });
    }
    const text = readText(file);
    if (text === null) continue;
    for (const rule of RULES) {
      if (rule.pattern.test(text)) violations.push({ file, rule: rule.name, where: "content" });
    }
  }
  return violations;
}

export function readTextFile(file) {
  try {
    const buffer = readFileSync(file);
    return buffer.subarray(0, 8000).includes(0) ? null : buffer.toString("utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function repoRoot() {
  const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dirname(SCRIPT_PATH),
    encoding: "utf8",
  });
  return out.trim();
}

function repoFiles(root) {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  );
  return out.split("\0").filter(Boolean);
}

if (process.argv[1] === SCRIPT_PATH) {
  const root = repoRoot();
  const violations = findViolations(repoFiles(root), (file) => readTextFile(join(root, file)));
  for (const v of violations) console.error(`hygiene: ${v.rule} in ${v.where} of ${v.file}`);
  process.exit(violations.length > 0 ? 1 : 0);
}
