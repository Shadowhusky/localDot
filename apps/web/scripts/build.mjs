import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMacNotifier } from "./mac-notifier.mjs";
import { writeNotices } from "./notices.mjs";

// Publish dependencies first and HTML last. Existing tabs can still import their old hashed
// chunks; never empty the directory from which a running daemon is serving the app.
export function publishBuild(staged, destination) {
  const files = readdirSync(staged, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      source: join(entry.parentPath, entry.name),
      relative: join(entry.parentPath.slice(staged.length), entry.name),
    }))
    .sort((a, b) => Number(a.relative.endsWith(".html")) - Number(b.relative.endsWith(".html")));
  for (const file of files) {
    const target = join(destination, file.relative);
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      copyFileSync(file.source, temporary);
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export function build(webDir) {
  const staged = mkdtempSync(join(tmpdir(), "localdot-web-build-"));
  try {
    const result = spawnSync(
      process.execPath,
      [join(webDir, "node_modules/vite/bin/vite.js"), "build", "--outDir", staged, "--emptyOutDir"],
      { cwd: webDir, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Frontend build failed (${result.status})`);
    writeNotices({ webDir, outDir: staged });
    buildMacNotifier(webDir, staged);
    publishBuild(staged, join(webDir, "dist"));
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
