import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// The app's own UI fixture: the real web app and daemon routes with a fake computer and sample data.
// Never the daemon on :4750.
const WEB = fileURLToPath(new URL("../../../web", import.meta.url));
export const TOKEN = "a".repeat(43);

export async function startFixture(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "localdot-film-update-"));
  const child = spawn(process.execPath, ["--import", "tsx", "e2e/fixtures/ui-server.ts"], {
    cwd: WEB,
    env: {
      ...process.env,
      QA_PORT: "0",
      QA_NOW: "2026-11-05T09:00:00.000Z",
      ...env,
      QA_HOME: home,
      QA_PARENT_PID: String(process.pid),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors = (errors + chunk).slice(-4000);
  });
  const ready = await new Promise((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`Fixture exited with ${code}\n${errors}`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.includes('"ready":true')) resolve(JSON.parse(line));
    });
  });
  return {
    ...ready,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}
