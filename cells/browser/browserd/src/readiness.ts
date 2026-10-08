import { type ChildProcess, execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { createConnection } from "node:net";
import {
  BROWSER_RUNTIME_DIR,
  type BrowserRuntimeConfig,
  browserProcessSpecs,
} from "./runtime-config.ts";

export type BrowserReadinessStage =
  | "display"
  | "monitor"
  | "dbus"
  | "windowManager"
  | "forwarder"
  | "stream";
export type BrowserReadinessProbe = (
  stage: BrowserReadinessStage,
  signal: AbortSignal,
) => Promise<boolean>;

export const BROWSER_READINESS_COMMAND_DRAIN_MS = 2000;

export class BrowserReadinessRetirementError extends Error {
  constructor() {
    super("Browser readiness utility retirement unconfirmed");
  }
}

function command(
  executable: string,
  args: string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let output: string | undefined;
    let settled = false;
    let failed = false;
    let killRequested = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(drainTimer);
      signal.removeEventListener("abort", terminate);
      if (!closed) reject(new BrowserReadinessRetirementError());
      else resolve(failed || signal.aborted ? undefined : output);
    };
    const terminate = () => {
      if (settled) return;
      failed = true;
      drainTimer ??= setTimeout(() => finish(false), BROWSER_READINESS_COMMAND_DRAIN_MS);
      if (!child || killRequested) return;
      killRequested = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    const deadline = setTimeout(terminate, 500);
    try {
      child = execFile(
        executable,
        args,
        {
          env: environment,
          signal,
          timeout: 500,
          killSignal: "SIGKILL",
          maxBuffer: 32768,
          encoding: "utf8",
        },
        (error, stdout) => {
          if (settled) return;
          if (error) terminate();
          else output = stdout;
        },
      );
    } catch {
      failed = true;
      finish(true);
      return;
    }
    child.once("close", () => finish(true));
    child.on("error", terminate);
    signal.addEventListener("abort", terminate, { once: true });
    if (failed || signal.aborted) terminate();
  });
}

function listening(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: 3129, signal });
    let finished = false;
    const finish = (ready: boolean) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

function streamReady(authorization: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const pending = request(
      {
        host: "127.0.0.1",
        port: 3000,
        path: "/api/status",
        method: "GET",
        headers: { authorization },
        signal,
        timeout: 500,
        agent: false,
      },
      (response) => {
        const ready = response.statusCode === 200;
        response.on("error", () => {});
        response.destroy();
        finish(ready);
      },
    );
    const finish = (ready: boolean) => {
      if (finished) return;
      finished = true;
      pending.destroy();
      resolve(ready);
    };
    pending.once("timeout", () => finish(false));
    pending.once("error", () => finish(false));
    pending.once("close", () => finish(false));
    pending.end();
  });
}

export function browserReadiness(config: BrowserRuntimeConfig): BrowserReadinessProbe {
  const environment = browserProcessSpecs(config).display.env;
  const authorization = `Basic ${Buffer.from(`localdot:${config.streamToken}`).toString("base64")}`;
  const width = 1280 * config.scale;
  const height = 800 * config.scale;
  const mode = `localdot-${width}x${height}`;
  let modeCreated = false;
  let modeAdded = false;
  const monitorReady = (output: string) => {
    const connected = output.split("\n").filter((line) => /^\S+ connected\b/u.test(line));
    return (
      connected.length === 1 &&
      new RegExp(`^screen connected (?:primary )?${width}x${height}\\+0\\+0(?: |$)`, "u").test(
        connected[0] ?? "",
      ) &&
      new RegExp(`^Screen 0:.* current ${width} x ${height},`, "mu").test(output)
    );
  };
  return async (stage, signal) => {
    if (signal.aborted) return false;
    if (stage === "display") {
      const output = await command("/usr/bin/xdpyinfo", [], environment, signal);
      const dimensions = output?.match(/dimensions:\s+(\d+)x(\d+)\s+pixels/u);
      return (
        Number(dimensions?.[1]) === 1280 * config.scale &&
        Number(dimensions?.[2]) === 800 * config.scale
      );
    }
    if (stage === "monitor") {
      // This image's Xvfb allocates the requested framebuffer but initially gives
      // its RandR output a 1280x1024 CRTC. XTest is clipped to that smaller output.
      // Configure the one fixed monitor before any browser or streaming client.
      const output = await command("/usr/bin/xrandr", ["--current"], environment, signal);
      if (output === undefined) return false;
      if (monitorReady(output)) return true;
      const connected = output.split("\n").filter((line) => /^\S+ connected\b/u.test(line));
      if (connected.length !== 1 || !/^screen connected\b/u.test(connected[0] ?? "")) return false;
      if (!modeCreated) {
        const timing =
          config.scale === 2
            ? ["348.50", "2560", "2752", "3032", "3504", "1600", "1603", "1609", "1658"]
            : ["83.50", "1280", "1352", "1480", "1680", "800", "803", "809", "831"];
        if (
          (await command(
            "/usr/bin/xrandr",
            ["--newmode", mode, ...timing, "-hsync", "+vsync"],
            environment,
            signal,
          )) === undefined
        )
          return false;
        modeCreated = true;
      }
      if (!modeAdded) {
        if (
          (await command("/usr/bin/xrandr", ["--addmode", "screen", mode], environment, signal)) ===
          undefined
        )
          return false;
        modeAdded = true;
      }
      if (
        (await command(
          "/usr/bin/xrandr",
          ["--output", "screen", "--mode", mode, "--pos", "0x0"],
          environment,
          signal,
        )) === undefined
      )
        return false;
      const verified = await command("/usr/bin/xrandr", ["--current"], environment, signal);
      return verified !== undefined && monitorReady(verified);
    }
    if (stage === "dbus") {
      try {
        const state = await lstat(`${BROWSER_RUNTIME_DIR}/session-bus`);
        return state.isSocket() && state.uid === 1000;
      } catch {
        return false;
      }
    }
    if (stage === "windowManager") {
      const output = await command(
        "/usr/bin/xprop",
        ["-root", "_NET_SUPPORTING_WM_CHECK"],
        environment,
        signal,
      );
      return /window id # 0x[1-9a-f][0-9a-f]*\b/iu.test(output ?? "");
    }
    if (stage === "forwarder") return listening(signal);
    if (stage === "stream") return streamReady(authorization, signal);
    return false;
  };
}
