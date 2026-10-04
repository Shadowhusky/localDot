import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestInfo } from "@playwright/test";

export interface AssemblyState {
  cell: { id: string; state: string; paused?: boolean; stream: { connection: string } };
  sessionId: string | null;
  status: string | null;
  generation: number | null;
  proxyHash: string | null;
  desktopTokenHash: string | null;
  streamTokenHash: string | null;
  events: { type: string; data: Record<string, unknown> }[];
  provider: {
    stage: number;
    model: string;
    tool: string;
    manualSentinelPresent: boolean;
    requestBytes: number;
  }[];
}
export async function assembledProcess(
  info: TestInfo,
  options: { pending: "wait" | "shell" } = { pending: "wait" },
) {
  if (process.env.LOCALDOT_ASSEMBLED_TESTS !== "1")
    throw new Error("Explicit Docker acceptance opt-in required");
  for (const name of [
    "LOCALDOT_BRAIN_IMAGE",
    "LOCALDOT_GATE_IMAGE",
    "LOCALDOT_DESKTOP_IMAGE",
    "LOCALDOT_KEYD_BIN",
  ])
    if (!process.env[name]) throw new Error(`Missing explicit ${name}`);
  const home = mkdtempSync("/tmp/ld-ui14-");
  const artifacts = info.outputPath("runtime");
  mkdirSync(artifacts, { recursive: true });
  const worker = fileURLToPath(
    new URL("../../../daemon/src/agent/testing/assembled-worker.ts", import.meta.url),
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "en_US.UTF-8",
    LOCALDOT_ASSEMBLED_TESTS: "1",
    LOCALDOT_ASSEMBLED_PENDING: options.pending,
    LOCALDOT_ACCEPTANCE_HOME: home,
    LOCALDOT_ACCEPTANCE_ARTIFACTS: artifacts,
    LOCALDOT_ACCEPTANCE_UI: fileURLToPath(new URL("../../dist", import.meta.url)),
  };
  for (const name of [
    "LOCALDOT_BRAIN_IMAGE",
    "LOCALDOT_GATE_IMAGE",
    "LOCALDOT_DESKTOP_IMAGE",
    "LOCALDOT_KEYD_BIN",
    "LOCALDOT_ACCEPTANCE_PORT",
    "LOCALDOT_ACCEPTANCE_TOOL_PORT",
  ])
    if (process.env[name]) env[name] = process.env[name];
  const child = spawn(process.execPath, ["--experimental-transform-types", worker], {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "",
    stderr = "",
    next = 0,
    exitCode: number | null | undefined;
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const captureFailures: unknown[] = [];
  const capture = () => {
    for (const { name, text } of [
      { name: "stdout.log", text: stdout },
      { name: "stderr.log", text: stderr },
    ]) {
      try {
        writeFileSync(join(artifacts, name), text);
      } catch (error) {
        captureFailures.push(error);
      }
    }
  };
  const exited = new Promise<void>((resolve) =>
    child.once("close", (code) => {
      exitCode = code;
      // Artifact failure must not escape the listener or strand a closed child's owner.
      try {
        capture();
      } finally {
        resolve();
      }
    }),
  );
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  let resolveReady!: (v: { url: string; images: Record<string, string>; pid: number }) => void,
    rejectReady!: (e: Error) => void;
  const ready = new Promise<{ url: string; images: Record<string, string>; pid: number }>(
    (resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    },
  );
  const readyTimer = setTimeout(
    () => rejectReady(new Error("Owned runtime startup timed out")),
    30_000,
  );
  child.once("error", rejectReady);
  child.once("close", () => {
    clearTimeout(readyTimer);
    rejectReady(
      new Error(`Owned runtime exited during startup (${exitCode}): ${stderr.slice(-2000)}`),
    );
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Owned runtime closed"));
    }
    pending.clear();
  });
  child.on("message", (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const value = v as {
      kind?: string;
      id?: number;
      ok?: boolean;
      value?: unknown;
      error?: string;
      url?: string;
      images?: Record<string, string>;
      pid?: number;
    };
    if (value.kind === "ready" && value.url && value.images && value.pid) {
      clearTimeout(readyTimer);
      resolveReady({ url: value.url, images: value.images, pid: value.pid });
      return;
    }
    if (typeof value.id !== "number") return;
    const item = pending.get(value.id);
    if (!item) return;
    pending.delete(value.id);
    clearTimeout(item.timer);
    if (value.ok) item.resolve(value.value);
    else item.reject(new Error(value.error ?? "Owned runtime command failed"));
  });
  const rpc = (kind: string, timeout = 5000, sessionId?: string) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Owned ${kind} deadline exceeded`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.send({ id, kind, sessionId }, (error) => {
        if (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    // Every caller joins the same completion and rejection, including after settlement.
    closePromise ??= Promise.resolve().then(retire);
    return closePromise;
  }
  async function retire(): Promise<void> {
    let cleanupFailure: unknown;
    try {
      if (child.connected) await rpc("close", 30_000);
    } catch (error) {
      cleanupFailure = error;
      child.kill("SIGTERM");
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
      capture();
      try {
        writeFileSync(
          join(artifacts, "ownership.json"),
          JSON.stringify(
            {
              home,
              pid: child.pid,
              worker,
              images: {
                brain: env.LOCALDOT_BRAIN_IMAGE,
                gate: env.LOCALDOT_GATE_IMAGE,
                desktop: env.LOCALDOT_DESKTOP_IMAGE,
              },
              exitCode,
              clean: !cleanupFailure && captureFailures.length === 0 && exitCode === 0,
              captureFailures: captureFailures.length,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        captureFailures.push(error);
      }
    }
    if (cleanupFailure || captureFailures.length || exitCode !== 0)
      throw new AggregateError(
        [...(cleanupFailure ? [cleanupFailure] : []), ...captureFailures],
        `Owned runtime cleanup failed; retained ${home}: ${String(cleanupFailure ?? exitCode)}; capture failures ${captureFailures.length}\n${stderr.slice(-2000)}`,
      );
  }
  try {
    const start = await ready;
    // Acquisition remains protected until all publication that can fail has completed.
    writeFileSync(
      join(artifacts, "start.json"),
      JSON.stringify({ home, ...start, url: new URL(start.url).origin }, null, 2),
    );
    return {
      ...start,
      home,
      artifacts,
      state: (sessionId?: string) => rpc("state", 5000, sessionId) as Promise<AssemblyState[]>,
      close,
      readProvider: () => readFileSync(join(home, "keyd/provider-requests.jsonl"), "utf8"),
    };
  } catch (error) {
    await close().catch((cleanup) => {
      throw new AggregateError([error, cleanup], "Startup and cleanup failed");
    });
    throw error;
  }
}
