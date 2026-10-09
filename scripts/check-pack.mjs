import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RULES } from "./check-hygiene.mjs";

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 4096;
export const PACK_ALLOWLIST = [
  /^(package\.json|README\.md|LICENSE|THIRD-PARTY\.md|release\.json|npm-shrinkwrap\.json)$/,
  /^bin\/localdot\.mjs$/,
  /^dist\/(cli|daemon|quiet-page-worker|release-verification-worker)\.mjs$/,
  /^dist\/browser-seccomp\.json$/,
  /^dist\/sandbox-runtime\/(package\.json|LICENSE|NOTICE\.md|PATCH\.txt)$/,
  /^dist\/sandbox-runtime\/dist\/cli\.mjs$/,
  /^dist\/sandbox-runtime\/vendor\/java-proxy-agent\/srt-proxy-agent\.jar$/,
  /^dist\/canary-(scan|worker)\.py$/,
  /^skills\/office-files\/SKILL\.md$/,
  /^web\/dist\/(index|export)\.html$/,
  /^web\/dist\/(sw\.js|manifest\.webmanifest)$/,
  /^web\/dist\/icons\/(apple-touch-icon|icon-192|icon-512|icon-maskable-512)\.png$/,
  /^web\/dist\/assets\/[A-Za-z0-9_.-]+\.(js|css|woff2|svg|png|webp)$/,
  /^web\/dist\/assets\/licenses\/[A-Za-z0-9_.@-]+\.txt$/,
  /^web\/vendor\/selkies\/(index\.html|manifest\.json|icon\.png|icon-512\.png|LICENSE|NOTICE\.md)$/,
  /^web\/vendor\/selkies\/assets\/[A-Za-z0-9_.-]+\.(js|css)$/,
];
export const PACK_RULES = [
  // macOS sandbox canonicalization needs /System/Volumes/Data. User-mounted volumes and
  // user-home paths (including their /System/Volumes/Data aliases) must never ship.
  { name: "developer path", pattern: /(?<!\/System)\/Volumes\/|\/Users\/[A-Za-z0-9._-]+\// },
  { name: "unset build constant", pattern: /__LOCALDOT_[A-Z_]+__/ },
];
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "THIRD-PARTY.md",
  "release.json",
  "npm-shrinkwrap.json",
  "bin/localdot.mjs",
  "dist/cli.mjs",
  "dist/daemon.mjs",
  "dist/quiet-page-worker.mjs",
  "dist/release-verification-worker.mjs",
  "dist/browser-seccomp.json",
  "dist/canary-scan.py",
  "dist/canary-worker.py",
  "dist/sandbox-runtime/package.json",
  "dist/sandbox-runtime/LICENSE",
  "dist/sandbox-runtime/NOTICE.md",
  "dist/sandbox-runtime/PATCH.txt",
  "dist/sandbox-runtime/dist/cli.mjs",
  "dist/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar",
  "skills/office-files/SKILL.md",
  "web/dist/index.html",
  "web/dist/export.html",
  "web/vendor/selkies/LICENSE",
  "web/vendor/selkies/NOTICE.md",
];
const CANONICAL = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*$/;
const TEXT = /\.(mjs|js|css|html|json|md|txt|py|svg|webmanifest)$/;

export function packFiles(dir) {
  const out = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"],
    {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      env: {
        ...process.env,
        npm_config_update_notifier: "false",
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
    },
  );
  const entries = JSON.parse(out);
  if (!Array.isArray(entries) || entries.length !== 1 || !Array.isArray(entries[0]?.files)) {
    throw new Error("npm returned an invalid package inventory");
  }
  return entries[0].files.map(({ path, size }) => ({ path, size }));
}

export function checkPack(dir, { rules = [...RULES, ...PACK_RULES], files = packFiles(dir) } = {}) {
  const problems = [];
  if (!Array.isArray(files) || files.length > MAX_PACKAGE_FILES)
    return ["invalid package inventory"];
  let root;
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return ["package root is not a directory"];
    root = realpathSync(dir);
  } catch {
    return ["package root is unreadable"];
  }
  const seen = new Set();
  const folded = new Set();
  let total = 0;
  for (const entry of files) {
    const path = entry?.path,
      size = entry?.size;
    if (
      typeof path !== "string" ||
      path.length > 512 ||
      !CANONICAL.test(path) ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      problems.push("invalid package inventory entry");
      continue;
    }
    const label = rules.some(({ pattern }) => new RegExp(pattern.source, pattern.flags).test(path))
      ? "[redacted package path]"
      : path;
    if (folded.has(path.toLowerCase())) {
      problems.push(`${label}: duplicate inventory entry`);
      continue;
    }
    seen.add(path);
    folded.add(path.toLowerCase());
    if (!PACK_ALLOWLIST.some((pattern) => pattern.test(path))) {
      problems.push(`${label}: not in the allowlist`);
      continue;
    }
    total += size;
    if (total > MAX_PACKAGE_BYTES) {
      problems.push("package exceeds byte limit");
      break;
    }
    if (size > MAX_FILE_BYTES) {
      problems.push(`${label}: exceeds file byte limit`);
      continue;
    }
    let bytes;
    try {
      bytes = readPackedFile(root, path);
    } catch {
      problems.push(`${label}: not a bounded regular file`);
      continue;
    }
    if (bytes.length !== size) problems.push(`${label}: inventory size does not match file`);
    // Reported sizes cannot hide actual aggregate bytes.
    total += Math.max(0, bytes.length - size);
    if (total > MAX_PACKAGE_BYTES) {
      problems.push("package exceeds byte limit");
      break;
    }
    if (TEXT.test(path) || path.endsWith("/LICENSE") || path === "LICENSE") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (bytes.includes(0)) throw new Error("NUL");
      } catch {
        problems.push(`${label}: invalid text encoding`);
      }
    }
    // Binary image/font metadata can contain a private name or key too. Do not skip NUL bytes.
    const text = bytes.toString("utf8");
    for (const { name, pattern } of rules) {
      const regex = new RegExp(pattern.source, pattern.flags);
      const matchesPath = regex.test(path);
      regex.lastIndex = 0;
      if (matchesPath || regex.test(text)) problems.push(`${label}: ${name}`);
    }
  }
  for (const path of REQUIRED) if (!seen.has(path)) problems.push(`${path}: missing`);
  if (
    ![...seen].some((path) => /^web\/dist\/assets\/licenses\/mediabunny-[\d.]+\.txt$/.test(path))
  ) {
    problems.push("Mediabunny license notice: missing");
  }
  return problems;
}

function readPackedFile(root, path) {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const st = lstatSync(join(root, ...parts.slice(0, i)));
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("linked parent");
  }
  const target = join(root, path),
    before = lstatSync(target);
  if (realpathSync(target) !== target) throw new Error("linked path");
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES)
    throw new Error("invalid file");
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = fstatSync(fd);
    if (realpathSync(target) !== target) throw new Error("changed path");
    if (
      !actual.isFile() ||
      actual.nlink !== 1 ||
      actual.size > MAX_FILE_BYTES ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino
    )
      throw new Error("changed file");
    const bytes = Buffer.alloc(actual.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!n) break;
      offset += n;
    }
    const after = fstatSync(fd);
    if (
      offset !== actual.size ||
      after.size !== actual.size ||
      after.mtimeMs !== actual.mtimeMs ||
      after.ctimeMs !== actual.ctimeMs
    ) {
      throw new Error("changed file");
    }
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const problems = checkPack(resolve(process.argv[2] ?? "apps/cli/pkg"));
    for (const problem of problems) console.error(`pack: ${problem}`);
    process.exitCode = problems.length ? 1 : 0;
  } catch {
    console.error("pack: package inventory could not be checked");
    process.exitCode = 1;
  }
}
