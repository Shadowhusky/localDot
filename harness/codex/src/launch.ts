import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ULID_PATTERN } from "@localdot/protocol";
import {
  type ApprovalContext,
  type BlockedStep,
  decideServerRequest,
  isApprovalCurrent,
} from "./approvals.ts";
import { MCP_BRIDGE, srtArgv } from "./args.ts";
import { CA_BUNDLE, codexEnv } from "./env.ts";
import { prepareCodexHome } from "./home.ts";
import { CodexInstallError, createCodexInstaller, type InstalledCodex } from "./install.ts";
import { type CodexProcess, spawnCodex } from "./process.ts";
import {
  type OwnedSandboxProfile,
  type SandboxPurpose,
  sandboxSettings,
  writeSettingsFile,
} from "./profile.ts";
import {
  assertOwnedCodexDirectory,
  assertOwnedCodexRoots,
  createOwnedCodexDirectory,
  type OwnedCodexDirectory,
  type OwnedCodexRoots,
  removeOwnedCodexDirectory,
} from "./roots.ts";
import { AppServerRpc, type AppServerRpcOptions } from "./rpc.ts";
import { codexBuild } from "./version.ts";

export type CodexLaunchFailure =
  | "cancelled"
  | "unsupported_platform"
  | "browser_unavailable"
  | "install_required"
  | "integrity_failed"
  | "invalid_request"
  | "endpoint_unavailable"
  | "startup_failed"
  | "startup_timed_out"
  | "transport_failed"
  | "process_exited"
  | "shutdown_failed";
const MESSAGES: Record<CodexLaunchFailure, string> = {
  cancelled: "The Codex launch was cancelled.",
  unsupported_platform: "The ChatGPT harness is unavailable on this computer.",
  browser_unavailable: "Browser sign-in is awaiting its bounded native callback check.",
  install_required: "Install the ChatGPT harness before signing in.",
  integrity_failed: "The pinned Codex executable could not be verified.",
  invalid_request: "The Codex launch request is invalid.",
  endpoint_unavailable: "The localDot Codex tool bridge is unavailable.",
  startup_failed: "The Codex connection could not be started.",
  startup_timed_out: "The Codex connection did not start in time.",
  transport_failed: "The Codex connection failed.",
  process_exited: "The Codex process ended unexpectedly.",
  shutdown_failed: "The Codex process or its resources could not be retired.",
};
export class CodexLaunchError extends Error {
  constructor(readonly code: CodexLaunchFailure) {
    super(MESSAGES[code]);
    this.name = "CodexLaunchError";
  }
}
export interface HarnessAvailability {
  readonly available: boolean;
  readonly reason?: string;
}
export function harnessAvailability(
  platform: string = process.platform,
  arch: string = process.arch,
  caBundle = CA_BUNDLE,
): HarnessAvailability {
  if (platform !== "darwin" || arch !== "arm64" || !codexBuild(platform, arch))
    return { available: false, reason: "The ChatGPT plan needs macOS on Apple silicon for now." };
  try {
    const file = lstatSync(caBundle);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      !file.size ||
      (file.mode & 0o022) !== 0 ||
      file.uid !== 0
    )
      throw new Error();
    accessSync(caBundle, constants.R_OK);
  } catch {
    return { available: false, reason: "The system certificate bundle is unavailable." };
  }
  return { available: true };
}
export interface LaunchDeps {
  readonly roots: OwnedCodexRoots;
  readonly extraDenyRead?: readonly string[];
}
// Only CodexAuthOwner's reserved lease calls the raw launcher in production. The same registered
// retirement handle owns startup, process and filesystem resources, including before the first await.
export interface CodexLaunchOwner {
  register(connection: CodexConnection): void;
  isCurrent(): boolean;
}
export interface LaunchInput {
  readonly purpose: SandboxPurpose;
  readonly sessionId?: string;
  readonly mcp?: OwnedCodexDirectory;
  readonly signal: AbortSignal;
  readonly owner: CodexLaunchOwner;
  readonly onFence: () => void;
  readonly approvalContext?: () => ApprovalContext;
  readonly onBlocked?: (step: BlockedStep) => void;
  readonly onNotification: AppServerRpcOptions["onNotification"];
  readonly onFailure: (error: CodexLaunchError) => void;
  readonly interruptTurn?: () => { threadId: string; turnId: string } | undefined;
}
export interface CodexConnection {
  readonly pid: number | undefined;
  readonly rpc: AppServerRpc;
  readonly workDir: string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly closed: Promise<void>;
  readonly failure: Promise<CodexLaunchError>;
  stop(): Promise<void>;
}
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};
function consume(value: unknown): boolean {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    Promise.resolve(value).catch(() => {});
    return true;
  }
  return false;
}
function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CodexLaunchError("shutdown_failed")), ms);
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
      .catch(() => {});
  });
}
function readonlyAwait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CodexLaunchError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
    if (signal.aborted) abort();
  });
}
const absentApproval: ApprovalContext = Object.freeze({
  captured: Object.freeze({
    generation: Object.freeze({ id: 0, signal: AbortSignal.abort() }),
    authGeneration: 0,
    turn: Object.freeze({ id: 0, signal: AbortSignal.abort(), basisFrameId: "" }),
    mainThreadId: undefined,
    turnId: undefined,
    controlHeld: true,
  }),
  current: () => undefined,
});

export async function launchCodex(deps: LaunchDeps, input: LaunchInput): Promise<CodexConnection> {
  const request = Object.freeze({ ...input }),
    roots = deps.roots,
    extra = Object.freeze([...(deps.extraDenyRead ?? [])]);
  if (request.signal.aborted) throw new CodexLaunchError("cancelled");
  const availability = harnessAvailability();
  if (!availability.available) throw new CodexLaunchError("unsupported_platform");
  // Task14 must prove the exact pin's bounded native listener before this release gate changes.
  if (request.purpose === "login-browser") throw new CodexLaunchError("browser_unavailable");
  const task = request.purpose === "task";
  if (!["task", "account"].includes(request.purpose)) throw new CodexLaunchError("invalid_request");
  if (!task && (request.mcp !== undefined || request.sessionId !== undefined))
    throw new CodexLaunchError("invalid_request");
  if (task) {
    try {
      if (!request.sessionId || !new RegExp(ULID_PATTERN).test(request.sessionId) || !request.mcp)
        throw new Error();
      assertOwnedCodexDirectory(roots, request.mcp, "runRoot");
      const socket = join(request.mcp.path, "m.sock"),
        file = lstatSync(socket),
        bridge = lstatSync(MCP_BRIDGE);
      if (
        Buffer.byteLength(socket) > 103 ||
        !file.isSocket() ||
        file.uid !== process.getuid?.() ||
        (file.mode & 0o777) !== 0o600 ||
        !bridge.isFile() ||
        bridge.isSymbolicLink() ||
        bridge.uid !== 0 ||
        (bridge.mode & 0o022) !== 0 ||
        realpathSync(MCP_BRIDGE) !== MCP_BRIDGE
      )
        throw new Error();
      accessSync(MCP_BRIDGE, constants.X_OK);
    } catch {
      throw new CodexLaunchError("endpoint_unavailable");
    }
  }
  const lifetime = new AbortController(),
    signal = AbortSignal.any([request.signal, lifetime.signal]);
  const startupDone = deferred<void>(),
    exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>(),
    closed = deferred<void>(),
    failure = deferred<CodexLaunchError>();
  let proc: CodexProcess | undefined,
    rpc: AppServerRpc | undefined,
    work: OwnedCodexDirectory | undefined,
    profile: OwnedSandboxProfile | undefined;
  let workPath = "",
    firstFailure: CodexLaunchError | undefined,
    retirementFailed = false;
  let admitted = true,
    fenced = false,
    reported = false,
    timedOut = false,
    stopped: ReturnType<typeof deferred<void>> | undefined;
  const current = () => {
    try {
      if (!admitted || signal.aborted) return false;
      const value: unknown = request.owner.isCurrent();
      return !consume(value) && value === true;
    } catch {
      return false;
    }
  };
  const check = () => {
    if (!current()) throw new CodexLaunchError(timedOut ? "startup_timed_out" : "cancelled");
    assertOwnedCodexRoots(roots);
  };
  const report = (code: CodexLaunchFailure) => {
    if (reported || code === "cancelled") return;
    reported = true;
    const error = new CodexLaunchError(code);
    firstFailure = error;
    fence();
    failure.resolve(error);
    try {
      Promise.resolve(request.onFailure(error)).catch(() => {});
    } catch {
      /* failure cannot revive the owner */
    }
  };
  const fence = () => {
    if (fenced) return;
    fenced = true;
    admitted = false;
    try {
      const value: unknown = request.onFence();
      if (consume(value)) report("transport_failed");
    } catch {
      report("transport_failed");
    }
  };
  const interrupt = () => {
    try {
      const value: unknown = request.interruptTurn?.();
      if (consume(value) || value === null || typeof value !== "object") return;
      const turn = value as { threadId?: unknown; turnId?: unknown };
      if (typeof turn.threadId === "string" && typeof turn.turnId === "string" && rpc)
        void rpc
          .request(
            "turn/interrupt",
            { threadId: turn.threadId, turnId: turn.turnId },
            {
              signal: new AbortController().signal,
              timeoutMs: 50,
              validateResult: () => undefined,
            },
          )
          .catch(() => {});
    } catch {
      /* independent containment still runs */
    }
  };
  const stop = (): Promise<void> => {
    if (stopped) return stopped.promise;
    stopped = deferred<void>();
    fence();
    interrupt();
    rpc?.close();
    lifetime.abort();
    let retirement: Promise<void>;
    try {
      retirement = proc
        ? Promise.all([proc.stop(), proc.closed]).then(() => {})
        : Promise.resolve();
    } catch {
      retirement = Promise.reject(new CodexLaunchError("shutdown_failed"));
    }
    const cleanup = Promise.all([startupDone.promise, retirement]).then(async () => {
      if (retirementFailed) throw new CodexLaunchError("shutdown_failed");
      if (profile) {
        await removeOwnedCodexDirectory(profile.directory);
        profile = undefined;
      }
      if (retirementFailed) throw new CodexLaunchError("shutdown_failed");
      if (work) {
        await removeOwnedCodexDirectory(work);
        work = undefined;
      }
    });
    void deadline(cleanup, 2000)
      .then(() => {
        signal.removeEventListener("abort", aborted);
        closed.resolve();
        stopped?.resolve();
      })
      .catch(() => {
        retirementFailed = true;
        report("shutdown_failed");
        stopped?.reject(new CodexLaunchError("shutdown_failed"));
      });
    return stopped.promise;
  };
  const connection: CodexConnection = Object.freeze({
    get pid() {
      return proc?.pid;
    },
    get rpc() {
      if (!rpc) throw new CodexLaunchError("startup_failed");
      return rpc;
    },
    get workDir() {
      return workPath;
    },
    exited: exited.promise,
    closed: closed.promise,
    failure: failure.promise,
    stop,
  });
  const aborted = () => {
    void stop().catch(() => {});
  };
  signal.addEventListener("abort", aborted, { once: true });
  const startupTimer = setTimeout(() => {
    timedOut = true;
    report("startup_timed_out");
    void stop().catch(() => {});
  }, 20000);
  startupTimer.unref();
  let error: CodexLaunchError | undefined;
  try {
    check();
    const registration: unknown = request.owner.register(connection);
    if (registration !== undefined) {
      consume(registration);
      throw new CodexLaunchError("startup_failed");
    }
    check();
    const verifier = createCodexInstaller({ roots });
    const installed = await readonlyAwait(verifier.verifiedInstallation(signal), signal);
    check();
    if (!installed) throw new CodexLaunchError("install_required");
    if (installed.platform !== "darwin-arm64") throw new CodexLaunchError("integrity_failed");
    check();
    prepareCodexHome(roots);
    check();
    work = createOwnedCodexDirectory(roots, "workRoot");
    workPath = work.path;
    check();
    const env = codexEnv({ roots, work, signal });
    check();
    const sandbox = {
      purpose: request.purpose,
      roots,
      installed,
      work,
      ...(request.mcp ? { mcp: request.mcp } : {}),
      extraDenyRead: extra,
    };
    profile = await writeSettingsFile(roots, sandboxSettings(sandbox));
    check();
    const verified = await readonlyAwait(verifier.verifiedInstallation(signal), signal);
    check();
    if (!verified || !sameInstall(installed, verified))
      throw new CodexLaunchError("integrity_failed");
    const argv = srtArgv({ sandbox, profile });
    check();
    proc = spawnCodex({
      command: argv.command,
      args: argv.args,
      cwd: work.path,
      env,
      signal,
      register: (record) => {
        proc = record;
        if (!current()) void record.stop().catch(() => {});
      },
      fence,
      interrupt: () => {
        interrupt();
        rpc?.close();
      },
    });
    const owned = proc;
    void owned.failure.then((cause) => {
      report(
        cause.code === "process_shutdown_failed"
          ? "shutdown_failed"
          : cause.code === "process_startup_failed"
            ? "startup_failed"
            : "transport_failed",
      );
      void stop().catch(() => {});
    });
    void owned.exited.then((outcome) => {
      exited.resolve(outcome);
      if (!stopped) {
        report("process_exited");
        void stop().catch(() => {});
      }
    });
    void owned.closed.then(() => {
      void stop().catch(() => {});
    });
    await readonlyAwait(owned.started, signal);
    check();
    if (!owned.stdout || !owned.stdin) throw new CodexLaunchError("startup_failed");
    rpc = new AppServerRpc({
      input: owned.stdout,
      output: owned.stdin,
      signal: lifetime.signal,
      onServerRequest: (method, params, context) => {
        let approval = absentApproval;
        if (task && current() && request.approvalContext) {
          const value = request.approvalContext();
          if (consume(value)) {
            report("transport_failed");
            void stop().catch(() => {});
          } else approval = value;
        }
        const decision = decideServerRequest(method, params, approval);
        if (current() && decision.blocked) {
          const value: unknown = request.onBlocked?.(decision.blocked);
          if (consume(value)) {
            report("transport_failed");
            void stop().catch(() => {});
          }
        }
        return {
          ...("result" in decision ? { result: decision.result } : { error: decision.error }),
          current: () =>
            current() &&
            !context.signal.aborted &&
            (decision.verdict !== "approved" || isApprovalCurrent(decision)),
        };
      },
      onNotification: (method, params, context) => {
        if (!current()) {
          void stop().catch(() => {});
          return;
        }
        return request.onNotification(method, params, context);
      },
      onFailure: () => {
        report("transport_failed");
        void stop().catch(() => {});
      },
    });
    check();
    return connection;
  } catch (cause) {
    error =
      signal.aborted && !request.signal.aborted && firstFailure
        ? firstFailure
        : cause instanceof CodexLaunchError
          ? cause
          : cause instanceof CodexInstallError
            ? new CodexLaunchError(
                cause.code === "integrity_failed" ? "integrity_failed" : "startup_failed",
              )
            : new CodexLaunchError(signal.aborted ? "cancelled" : "startup_failed");
    report(error.code);
  } finally {
    clearTimeout(startupTimer);
    startupDone.resolve();
    if (!proc) exited.resolve({ code: null, signal: null });
  }
  try {
    await stop();
  } catch {
    throw new CodexLaunchError("shutdown_failed");
  }
  throw error ?? new CodexLaunchError("startup_failed");
}
function sameInstall(a: InstalledCodex, b: InstalledCodex): boolean {
  return (
    a.version === b.version &&
    a.platform === b.platform &&
    a.binDir === b.binDir &&
    a.codexBin === b.codexBin &&
    a.codeModeHostBin === b.codeModeHostBin
  );
}
