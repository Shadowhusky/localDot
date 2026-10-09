import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CellStore } from "./cells/store.ts";
import { sampleRecord } from "./cells/testing/sample-record.ts";

const DAEMON_DIR = fileURLToPath(new URL("..", import.meta.url));
let child: ChildProcess | undefined;
let wedged: Server | undefined;

afterEach(async () => {
  child?.kill("SIGKILL");
  child = undefined;
  const server = wedged;
  wedged = undefined;
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

// A Docker socket that accepts every connection and never answers, as a wedged Docker Desktop does.
// It reads what arrives, so it sees each client go away and can close.
async function wedgedDocker(): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "ld-wedged-")), "d.sock");
  const server = createServer((socket) => socket.resume());
  wedged = server;
  await new Promise<void>((r) => server.listen(path, r));
  return path;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

describe("daemon startup", () => {
  it("serves while a wedged Docker holds the cells' reconcile", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "local dot's main-")), "home");
    new CellStore(home).save(sampleRecord());
    const socket = await wedgedDocker();
    const port = await freePort();
    let stderr = "";
    child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: DAEMON_DIR,
      env: {
        ...process.env,
        LOCALDOT_NOTIFY_MAC: "off",
        LOCALDOT_HOME: home,
        LOCALDOT_PORT: String(port),
        DOCKER_HOST: `unix://${socket}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    let status = 0;
    const deadline = Date.now() + 10_000;
    while (status !== 200 && Date.now() < deadline) {
      status = await fetch(`http://127.0.0.1:${port}/healthz`).then(
        (r) => r.status,
        () => 0,
      );
      if (status !== 200) await new Promise((r) => setTimeout(r, 100));
    }
    expect(status, `no /healthz answer while Docker said nothing; stderr: ${stderr}`).toBe(200);
  }, 15_000);
});
