import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
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
  // Complete raw stderr received since spawn, while this helper is alive. Throws
  // if capture failed or the artifact changed. stop() removes the owned artifact.
  stderrPath(): string;
  // Optionally preserve a final snapshot after close drains every stderr byte.
  // artifactsTo must be a new directory; its parent must already exist.
  stop(opts?: { artifactsTo?: string }): Promise<void>;
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
    if (ownHome) rmSync(home, { recursive: true, force: true });
    throw new Error(`keyd's socket path is too long for macOS (${socketPath})`);
  }
  let captureDirectory: string | undefined;
  let captureFd: number | undefined;
  let captureFailure: Error | undefined;
  let capturedBytes = 0;
  const clean = () => {
    if (captureFd !== undefined) {
      try {
        closeSync(captureFd);
      } catch {
        captureFailure ??= new Error("keyd stderr capture could not close");
      }
      captureFd = undefined;
    }
    try {
      if (captureDirectory) rmSync(captureDirectory, { recursive: true, force: true });
    } finally {
      if (ownHome) rmSync(home, { recursive: true, force: true });
    }
  };
  let capturePath: string;
  try {
    captureDirectory = mkdtempSync(`/tmp/ld-keyd-stderr-${process.pid}-`);
    capturePath = join(captureDirectory, "stderr.log");
    captureFd = openSync(capturePath, "wx", 0o600);
  } catch (error) {
    clean();
    throw error;
  }
  const ports = opts.ports ?? TEST_KEYD_PORTS;
  let child: ChildProcess;
  try {
    child = spawn(
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
  } catch (error) {
    clean();
    throw error;
  }
  let stderr = "";
  const decoder = new StringDecoder("utf8");
  const stderrPath = () => {
    if (captureFailure) throw captureFailure;
    if (captureFd === undefined) throw new Error("keyd stderr capture is closed");
    const descriptor = fstatSync(captureFd);
    const artifact = lstatSync(capturePath);
    if (
      !artifact.isFile() ||
      artifact.dev !== descriptor.dev ||
      artifact.ino !== descriptor.ino ||
      artifact.size !== capturedBytes
    ) {
      throw new Error("keyd stderr capture artifact changed");
    }
    return capturePath;
  };
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  // A test process that dies takes its keyd with it.
  const killOnExit = () => child.kill("SIGKILL");
  process.once("exit", killOnExit);
  const bootId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`keyd did not get ready within 15 s:\n${stderr}`));
    }, 15_000);
    const captureFailed = () => {
      captureFailure ??= new Error("keyd stderr capture failed");
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(captureFailure);
    };
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`keyd exited with ${code} before it was ready:\n${stderr}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`keyd could not start: ${error.message}`));
    });
    if (!child.stderr) {
      captureFailed();
      return;
    }
    child.stderr.on("error", captureFailed);
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        if (captureFailure || captureFd === undefined) throw new Error("capture unavailable");
        let offset = 0;
        while (offset < chunk.length) {
          const written = writeSync(captureFd, chunk, offset, chunk.length - offset);
          if (written <= 0) throw new Error("capture made no progress");
          offset += written;
          capturedBytes += written;
        }
      } catch {
        captureFailed();
        return;
      }
      stderr = (stderr + decoder.write(chunk)).slice(-64 * 1024);
      const ready = /^keyd ready socket=(.+) boot=([0-9a-f]{16})$/m.exec(stderr);
      if (ready?.[2]) {
        clearTimeout(timer);
        resolve(ready[2]);
      }
    });
  }).catch(async (error: unknown) => {
    process.removeListener("exit", killOnExit);
    child.kill("SIGKILL");
    await exited;
    clean();
    throw error;
  });
  const preserve = (artifactsTo: string) => {
    const source = stderrPath();
    const destination = join(realpathSync(dirname(artifactsTo)), basename(artifactsTo));
    for (const directory of [home, captureDirectory]) {
      if (!directory) continue;
      const original = realpathSync(directory);
      if (destination === original || destination.startsWith(`${original}${sep}`)) {
        throw new Error("keyd artifacts destination must be outside its source directories");
      }
    }
    // Nonrecursive mkdir is exclusive: an existing path is never reused or removed.
    mkdirSync(destination, { mode: 0o700 });
    try {
      copyFileSync(source, join(destination, "stderr.log"), constants.COPYFILE_EXCL);
      cpSync(home, join(destination, "keyd-home"), {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
      stderrPath();
    } catch (error) {
      // A partial snapshot must not look like complete acceptance evidence.
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  };
  const stop = async (options: { artifactsTo?: string } = {}) => {
    process.removeListener("exit", killOnExit);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    }
    try {
      // exit can precede close: final bytes and the home are immutable only after
      // the child and its stderr pipe have both closed.
      await exited;
      if (options.artifactsTo !== undefined) preserve(options.artifactsTo);
    } finally {
      clean();
    }
    if (captureFailure) throw captureFailure;
  };
  return { home, socketPath, bootId, stderr: () => stderr, stderrPath, stop };
}
