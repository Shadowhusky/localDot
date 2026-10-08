import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const TOKEN = "a".repeat(43);
const WEB = fileURLToPath(new URL("../..", import.meta.url));

export interface UiFixture {
  origin: string;
  seeded: string[];
  close(): Promise<void>;
}

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (!address || typeof address === "string") throw new Error("No free port");
  return address.port;
}

// Starts ui-server.ts on QA_PORT or a free port; `env` selects its scenario (QA_PHASE, QA_CELL, …).
export async function startUiFixture(env: Record<string, string> = {}): Promise<UiFixture> {
  const port = process.env.QA_PORT ? Number(process.env.QA_PORT) : await freePort();
  const home = mkdtempSync(join(tmpdir(), "localdot-ui-"));
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "e2e/fixtures/ui-server.ts"],
    { cwd: WEB, env: { ...process.env, ...env, QA_PORT: String(port), QA_HOME: home } },
  );
  const ready = await new Promise<{ origin: string; seeded: string[] }>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n").find((entry) => entry.includes('"ready":true'));
      if (line) resolve(JSON.parse(line));
    });
    child.once("exit", (code) => reject(new Error(`Fixture exited with ${code}`)));
  });
  return {
    ...ready,
    async close() {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
