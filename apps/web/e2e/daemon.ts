import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type KeydProcess,
  startKeyd as startTestKeyd,
  TEST_KEYD_PORTS,
} from "../../daemon/src/keyd/testing/keyd-process.ts";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
export const E2E_PORT = 4790;
export const E2E_KEYD_PORTS = `${TEST_KEYD_PORTS.from}-${TEST_KEYD_PORTS.to}`;

export type RunningKeyd = KeydProcess;
export const startKeyd = (home: string): Promise<RunningKeyd> => startTestKeyd({ home });

export const docker = (...args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();

export function desktopContainer(cellId: string): string {
  return docker(
    "ps",
    "--filter",
    `label=localdot.cell=${cellId}`,
    "--filter",
    "label=localdot.role=desktop",
    "--format",
    "{{.Names}}",
  );
}

export interface RunningDaemon {
  origin: string;
  token: string;
  home: string;
  keyd: RunningKeyd;
  request(path: string, init?: RequestInit): Promise<Response>;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

// A separate home and process group per run. No SSD bind mounts, no shared user's state.
export async function startDaemon(
  env: Record<string, string> = {},
  options: { calibrationFile?: string; home?: string } = {},
): Promise<RunningDaemon> {
  const scratch = mkdtempSync(join(tmpdir(), "local dot's e2e-"));
  const home = options.home ?? join(scratch, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (options.calibrationFile) {
    mkdirSync(home, { recursive: true });
    const target = join(home, "calibration.json");
    copyFileSync(options.calibrationFile, target);
    chmodSync(target, 0o600);
  }
  const origin = `http://127.0.0.1:${E2E_PORT}`;
  let child: ChildProcess;
  let keyd: RunningKeyd | undefined;
  let token = "";
  let log = "";
  const killGroup = (signal: NodeJS.Signals) => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }
  };
  const terminate = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const force = setTimeout(() => killGroup("SIGKILL"), 10_000);
    killGroup("SIGTERM");
    await exited;
    clearTimeout(force);
  };
  const killOnExit = () => killGroup("SIGKILL");
  process.once("exit", killOnExit);
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(`${origin}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  };
  const launch = async () => {
    log = "";
    child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: join(REPO, "apps", "daemon"),
      env: {
        ...process.env,
        LOCALDOT_KEYD_PORTS: E2E_KEYD_PORTS,
        ...env,
        LOCALDOT_HOME: home,
        LOCALDOT_PORT: String(E2E_PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const collect = (data: Buffer) => {
      log = (log + data.toString().replace(/#token=[A-Za-z0-9_-]+/g, "#token=[redacted]")).slice(
        -8000,
      );
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let spawnError: Error | undefined;
    child.on("error", (err) => {
      spawnError = err;
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
      try {
        token = readFileSync(join(home, "daemon-token"), "utf8").trim();
        // Prove this is our daemon, not an unrelated process already holding the port.
        if ((await request("/api/whoami")).ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await terminate();
    throw new Error(`The test daemon did not start: ${spawnError?.message ?? log}`);
  };
  const stop = async () => {
    let cleaned = false;
    try {
      const response = await request("/api/cells");
      if (!response.ok) throw new Error(`cell listing failed (${response.status})`);
      const cells = (await response.json()) as { id: string }[];
      for (const cell of cells) {
        const removed = await request(`/api/cells/${cell.id}?purge=1`, { method: "DELETE" });
        if (!removed.ok) throw new Error(`test cell cleanup failed (${removed.status})`);
      }
      cleaned = true;
    } finally {
      try {
        await terminate();
      } finally {
        await keyd?.stop();
        process.removeListener("exit", killOnExit);
        if (cleaned) rmSync(scratch, { recursive: true, force: true });
      }
    }
  };
  try {
    keyd = await startKeyd(home);
    await launch();
  } catch (err) {
    await keyd?.stop();
    process.removeListener("exit", killOnExit);
    rmSync(scratch, { recursive: true, force: true });
    throw err;
  }
  return {
    origin,
    token,
    home,
    keyd,
    request,
    restart: async () => {
      await terminate();
      await launch();
    },
    stop,
  };
}
