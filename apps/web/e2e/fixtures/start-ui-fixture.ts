import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const TOKEN = "a".repeat(43);
const WEB = fileURLToPath(new URL("../..", import.meta.url));

function newest(dir: string): number {
  return Math.max(
    0,
    ...readdirSync(dir, { withFileTypes: true }).map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return newest(path);
      return /\.test\.tsx?$/.test(entry.name) ? 0 : statSync(path).mtimeMs;
    }),
  );
}

// Fails when `built` (relative to apps/web) is missing or older than any source file, naming the
// script that rebuilds it.
export function assertFreshBuild(built: string, script: string) {
  const file = join(WEB, built);
  if (!existsSync(file) || newest(join(WEB, "src")) > statSync(file).mtimeMs)
    throw new Error(`${built} is older than src: run pnpm --filter @localdot/web ${script}.`);
}

export interface UiFixture {
  origin: string;
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
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-4000);
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
    const ready = await new Promise<Omit<UiFixture, "close">>((resolve, reject) => {
      child.once("exit", (code) => reject(new Error(`Fixture exited with ${code}\n${errors}`)));
      const lines = createInterface({ input: child.stdout as NonNullable<typeof child.stdout> });
      lines.on("line", (line) => {
        if (line.includes('"ready":true')) resolve(JSON.parse(line));
      });
    });
    return { ...ready, close };
  } catch (error) {
    await close();
    throw error;
  }
}
