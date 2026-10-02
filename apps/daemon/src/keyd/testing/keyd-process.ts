import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePortRange } from "../../cells/ports.ts";
import { keydSocketPath } from "../client.ts";

export const KEYD_TESTS = process.env.LOCALDOT_KEYD_TESTS === "1";
// Test keyds listen in the spikes/e2e block, clear of the e2e daemon (4790) and the driver
// opt-out proxy (4798), so they never collide with a real keyd on 4760-4789.
// LOCALDOT_TEST_KEYD_PORTS moves them when two checkouts test on one Mac.
export const TEST_KEYD_PORTS = parsePortRange(process.env.LOCALDOT_TEST_KEYD_PORTS || "4791-4797");
const KEYD_DIR = fileURLToPath(new URL("../../../../../keyd/", import.meta.url));
// macOS limits a Unix socket path to 103 bytes.
const MAX_SOCKET_PATH = 103;

let built: string | undefined;

// keyd from this checkout. The keyd and Docker test configs build it once per run (keyd-build.ts)
// and remove it afterwards; outside them it is built once per test process.
export function keydBinary(): string {
  if (process.env.LOCALDOT_KEYD_BIN) return process.env.LOCALDOT_KEYD_BIN;
  if (built) return built;
  const dir = mkdtempSync(join(tmpdir(), "localdot-keyd-bin-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "keyd");
  execFileSync(process.env.GO ?? "go", ["build", "-o", out, "./cmd/keyd"], {
    cwd: KEYD_DIR,
    stdio: ["ignore", "ignore", "inherit"],
  });
  built = out;
  return out;
}

export interface KeydProcess {
  home: string;
  socketPath: string;
  bootId: string;
  stderr(): string;
  stop(): Promise<void>;
}

export interface StartKeydOptions {
  home?: string;
  ports?: { from: number; to: number };
}

// A real keyd with an in-memory vault, as Part 4a's README runs one: it prints one ready line on
// stderr, and SIGTERM closes every cell and removes the socket.
export async function startKeyd(opts: StartKeydOptions = {}): Promise<KeydProcess> {
  // Build before creating state, so a failed toolchain leaves no owned home behind.
  const binary = keydBinary();
  const ownHome = opts.home === undefined;
  const home = opts.home ?? mkdtempSync(`/tmp/ld-keyd-${process.pid}-`);
  const socketPath = keydSocketPath(home);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    throw new Error(`keyd's socket path is too long for macOS (${socketPath})`);
  }
  const ports = opts.ports ?? TEST_KEYD_PORTS;
  const child: ChildProcess = spawn(
    binary,
    [
      "-home",
      home,
      "-vault",
      "memory",
      "-ports",
      `${ports.from}-${ports.to}`,
      // Tests ask neither the router nor STUN for the public address: nothing leaves the Mac.
      "-natpmp",
      "off",
      "-stun",
      "off",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  // A test process that dies takes its keyd with it.
  const killOnExit = () => child.kill("SIGKILL");
  process.once("exit", killOnExit);
  const bootId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`keyd did not get ready within 15 s:\n${stderr}`));
    }, 15_000);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
      const ready = /^keyd ready socket=(.+) boot=([0-9a-f]{16})$/m.exec(stderr);
      if (ready?.[2]) {
        clearTimeout(timer);
        resolve(ready[2]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`keyd exited with ${code} before it was ready:\n${stderr}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`keyd could not start: ${error.message}`));
    });
  }).catch(async (error: unknown) => {
    process.removeListener("exit", killOnExit);
    child.kill("SIGKILL");
    await exited;
    if (ownHome) rmSync(home, { recursive: true, force: true });
    throw error;
  });
  const stop = async () => {
    process.removeListener("exit", killOnExit);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    }
    if (ownHome) rmSync(home, { recursive: true, force: true });
  };
  return { home, socketPath, bootId, stderr: () => stderr, stop };
}
