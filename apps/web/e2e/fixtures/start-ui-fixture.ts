import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const TOKEN = "a".repeat(43);
const WEB = fileURLToPath(new URL("../..", import.meta.url));

const SHARED = [
  "src",
  "vite.config.ts",
  "../../packages/protocol/src",
  "../../packages/providers/src",
  "../../packages/stage/src",
];
// What each build is made from, relative to apps/web. The app never imports the gallery, so the
// gallery's own sources leave the app's build current.
const BUILDS = {
  app: {
    built: "dist/index.html",
    script: "build",
    inputs: [...SHARED, "index.html"],
    skip: ["src/gallery"],
  },
  gallery: {
    built: "dist-gallery/gallery.html",
    script: "build:gallery",
    inputs: [...SHARED, "gallery.html", "vite.gallery.config.ts", "e2e/fixtures/ui-assets"],
    skip: [],
  },
};
export type Build = keyof typeof BUILDS;

interface Newest {
  path: string;
  mtimeMs: number;
}

function newest(path: string, skip: Set<string>): Newest | undefined {
  if (skip.has(path) || !existsSync(path)) return undefined;
  const stat = statSync(path);
  if (!stat.isDirectory())
    return /\.test\.tsx?$/.test(path) ? undefined : { path, mtimeMs: stat.mtimeMs };
  let found: Newest | undefined;
  for (const entry of readdirSync(path)) {
    const candidate = newest(join(path, entry), skip);
    if (candidate && (!found || candidate.mtimeMs > found.mtimeMs)) found = candidate;
  }
  return found;
}

// Why `build` is out of date under `web` (apps/web), naming the script that rebuilds it.
export function staleBuild(build: Build, web = WEB): string | undefined {
  const { built, script, inputs, skip } = BUILDS[build];
  const rebuild = `run pnpm --filter @localdot/web ${script}`;
  const file = join(web, built);
  if (!existsSync(file)) return `${built} is missing: ${rebuild}.`;
  const skipped = new Set(skip.map((path) => join(web, path)));
  const builtAt = statSync(file).mtimeMs;
  for (const input of inputs) {
    const changed = newest(join(web, input), skipped);
    if (changed && changed.mtimeMs > builtAt)
      return `${built} is older than ${relative(web, changed.path)}: ${rebuild}.`;
  }
}

export function assertFreshBuild(build: Build) {
  const problem = staleBuild(build);
  if (problem) throw new Error(problem);
}

export interface UiFixture {
  origin: string;
  home: string;
  sessionId?: string;
  seeded: string[];
  close(): Promise<void>;
}

// Starts ui-server.ts on QA_PORT, or on a port the system picks; `env` selects its state
// (QA_SCENARIO, or QA_PHASE, QA_CELL, …). `label` names its scratch home.
export async function startUiFixture(
  env: Record<string, string> = {},
  label = "localdot-ui",
): Promise<UiFixture> {
  const home = mkdtempSync(join(tmpdir(), `${label}-`));
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "e2e/fixtures/ui-server.ts"],
    {
      cwd: WEB,
      env: {
        ...process.env,
        QA_PORT: process.env.QA_PORT ?? "0",
        ...env,
        QA_HOME: home,
        QA_PARENT_PID: String(process.pid),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // The fixture's errors are held for the failure message until it is up, then passed through.
  let errors = "";
  let up = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    if (up) process.stderr.write(chunk);
    else errors = (errors + chunk.toString()).slice(-4000);
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  };
  try {
    const ready = await new Promise<Omit<UiFixture, "home" | "close">>((resolve, reject) => {
      child.once("exit", (code) => reject(new Error(`Fixture exited with ${code}\n${errors}`)));
      const lines = createInterface({ input: child.stdout as NonNullable<typeof child.stdout> });
      lines.on("line", (line) => {
        if (line.includes('"ready":true')) resolve(JSON.parse(line));
      });
    });
    up = true;
    if (errors) process.stderr.write(errors);
    return { ...ready, home, close };
  } catch (error) {
    await close();
    throw error;
  }
}
