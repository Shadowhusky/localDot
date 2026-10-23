import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { prepareProfilePreferences, releaseProfileLocks } from "./profile-preferences.ts";
import {
  BROWSER_DOWNLOAD_DIR,
  BROWSER_PROFILE_DIR,
  BROWSER_RUNTIME_DIR,
  type BrowserRuntimeConfig,
  browserProcessSpecs,
} from "./runtime-config.ts";

export const BROWSER_PREPARATION_COMMAND_MS = 10_000;
export const BROWSER_PREPARATION_DRAIN_MS = 2000;
const HOME = "/home/browser";
const CERTIFICATE = "/etc/localdot/cell/ca.pem";
const NSS = `${HOME}/.pki/nssdb`;
const MAX_COMMAND_OUTPUT = 1024;

export class BrowserPreparationError extends Error {
  constructor(readonly retirementUncertain = false) {
    super("Browser preparation failed");
  }
}

function check(signal: AbortSignal): void {
  if (signal.aborted) throw new BrowserPreparationError();
}

async function directory(path: string, create: "fresh" | "profile" | "existing"): Promise<void> {
  if (create !== "existing") {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (create !== "profile" || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const state = await lstat(path);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.uid !== 1000 ||
    (state.mode & 0o777) !== 0o700
  )
    throw new BrowserPreparationError();
}

type PreparationCommand = "hash" | "database" | "trust";

function command(kind: PreparationCommand, signal: AbortSignal, secret?: string): Promise<string> {
  check(signal);
  const executable = kind === "hash" ? "/usr/bin/openssl" : "/usr/bin/certutil";
  const args =
    kind === "hash"
      ? ["passwd", "-6", "-stdin"]
      : kind === "database"
        ? ["-N", "--empty-password", "-d", `sql:${NSS}`]
        : ["-A", "-t", "C,,", "-n", "localdot-cell", "-d", `sql:${NSS}`, "-i", CERTIFICATE];
  const child = spawn(executable, args, {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", HOME, LANG: "C.UTF-8" },
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  return new Promise<string>((resolve, reject) => {
    const output: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    let settled = false;
    let closed = false;
    let retired = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const group = (sent: 0 | "SIGKILL"): boolean => {
      if (retired) return false;
      const processId = child.pid;
      if (processId === undefined) return !closed;
      if (!Number.isSafeInteger(processId) || processId <= 1) {
        failed = true;
        return true;
      }
      try {
        process.kill(-processId, sent);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          retired = true;
          return false;
        }
        failed = true;
        return true;
      }
    };
    const finish = () => {
      if (settled) return;
      const retirementUncertain = !closed || group(0);
      settled = true;
      clearTimeout(deadline);
      clearTimeout(drainTimer);
      clearTimeout(pollTimer);
      signal.removeEventListener("abort", abort);
      if (failed || retirementUncertain) reject(new BrowserPreparationError(retirementUncertain));
      else resolve(Buffer.concat(output).toString("utf8"));
    };
    const terminate = () => {
      if (settled) return;
      failed = true;
      group("SIGKILL");
      drainTimer ??= setTimeout(finish, BROWSER_PREPARATION_DRAIN_MS);
    };
    const drained = () => {
      if (settled) return;
      if (!group(0)) {
        finish();
        return;
      }
      terminate();
      pollTimer = setTimeout(drained, 20);
    };
    const abort = () => terminate();
    const deadline = setTimeout(terminate, BROWSER_PREPARATION_COMMAND_MS);
    signal.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => {
      if (failed || signal.aborted || !Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 1)
        terminate();
    });
    child.on("error", terminate);
    child.stdin.on("error", terminate);
    child.stdout.on("error", terminate);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || failed) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_COMMAND_OUTPUT) terminate();
      else output.push(Buffer.from(chunk));
    });
    child.once("close", (code) => {
      closed = true;
      if (code !== 0 || signal.aborted) failed = true;
      drained();
    });
    if (signal.aborted) terminate();
    try {
      child.stdin.end(kind === "hash" ? `${secret}\n` : undefined);
    } catch {
      terminate();
    }
  });
}

export async function prepareBrowserRuntime(
  config: BrowserRuntimeConfig,
  signal: AbortSignal,
): Promise<void> {
  try {
    check(signal);
    const captured = Object.freeze({
      browserCellId: config.browserCellId,
      parentCellId: config.parentCellId,
      serviceToken: config.serviceToken,
      streamToken: config.streamToken,
      gateAddress: config.gateAddress,
      scale: config.scale,
      fullcolor: config.fullcolor,
      gpu: config.gpu,
      timezone: config.timezone,
    });
    browserProcessSpecs(captured);
    if (process.getuid?.() !== 1000) throw new BrowserPreparationError();
    await directory(HOME, "existing");
    check(signal);
    await directory("/profile", "existing");
    check(signal);
    await directory(BROWSER_RUNTIME_DIR, "fresh");
    check(signal);
    await directory(BROWSER_DOWNLOAD_DIR, "existing");
    for (const path of ["client", "proxy", "fastcgi", "uwsgi", "scgi", "uploads"]) {
      check(signal);
      await directory(`${BROWSER_RUNTIME_DIR}/${path}`, "fresh");
    }
    for (const path of [`${HOME}/.config`, `${HOME}/.pki`, NSS]) {
      check(signal);
      await directory(path, "fresh");
    }
    check(signal);
    await directory(BROWSER_PROFILE_DIR, "profile");
    await releaseProfileLocks(BROWSER_PROFILE_DIR, signal);
    await prepareProfilePreferences(BROWSER_PROFILE_DIR, signal);
    check(signal);
    const certificate = await lstat(CERTIFICATE);
    if (
      !certificate.isFile() ||
      certificate.isSymbolicLink() ||
      certificate.size < 1 ||
      certificate.size > 65536
    )
      throw new BrowserPreparationError();
    const hashed = (await command("hash", signal, captured.streamToken)).trim();
    check(signal);
    if (!/^\$6\$[A-Za-z0-9./]{1,16}\$[A-Za-z0-9./]{86}$/u.test(hashed))
      throw new BrowserPreparationError();
    const file = await open(
      `${BROWSER_RUNTIME_DIR}/stream.htpasswd`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      check(signal);
      const state = await file.stat();
      if (
        !state.isFile() ||
        state.uid !== 1000 ||
        state.nlink !== 1 ||
        (state.mode & 0o777) !== 0o600
      )
        throw new BrowserPreparationError();
      await file.writeFile(`localdot:${hashed}\n`, "utf8");
      check(signal);
    } finally {
      await file.close();
    }
    for (const kind of ["database", "trust"] as const) {
      check(signal);
      if ((await command(kind, signal)).trim() !== "") throw new BrowserPreparationError();
    }
    check(signal);
  } catch (error) {
    if (error instanceof BrowserPreparationError) throw error;
    throw new BrowserPreparationError();
  }
}
