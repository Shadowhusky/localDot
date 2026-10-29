import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  BrowserFailureKind,
  BrowserManualPermit,
  BrowserSignInMode,
  BrowserSupervisorState,
} from "../../../../packages/protocol/src/browser-control.ts";
import { WorkWindow } from "../../../desktop/desktopd/src/work-window.ts";
import { BrowserAccounts } from "./accounts.ts";
import { BrowserCapture } from "./capture.ts";
import { BrowserControl } from "./control.ts";
import { BrowserDownloadService } from "./download-service.ts";
import { BrowserGeometry } from "./geometry.ts";
import { BrowserHttp } from "./http.ts";
import { BrowserInput } from "./input.ts";
import { BrowserNative } from "./native.ts";
import { BrowserNavigation } from "./navigation-owner.ts";
import { BrowserObservation } from "./observation.ts";
import { pipeTransport } from "./pipe.ts";
import { BrowserPreparationError, prepareBrowserRuntime } from "./prepare.ts";
import {
  type BrowserProcessChannels,
  type BrowserProcessDriver,
  BrowserProcessError,
  type BrowserProcessExit,
  BrowserProcesses,
} from "./processes.ts";
import { releaseProfileLocks } from "./profile-preferences.ts";
import {
  type BrowserReadinessProbe,
  BrowserReadinessRetirementError,
  type BrowserReadinessStage,
  browserReadiness,
} from "./readiness.ts";
import {
  BROWSER_DOWNLOAD_DIR,
  BROWSER_PROFILE_DIR,
  BROWSER_UPLOAD_DIR,
  type BrowserRuntimeConfig,
  browserProcessSpecs,
  browserSignInSpec,
} from "./runtime-config.ts";
import { BrowserSecrets } from "./secrets.ts";
import { BrowserTargetError, BrowserTargets } from "./targets.ts";
import { BrowserUploadService } from "./upload-service.ts";

export const BROWSER_RUNTIME_START_MS = 60_000;
export const BROWSER_READINESS_MS = 15_000;
// A failed Chromium starts again in place, keeping the display, stream and profile, at most this
// often; past that the runtime retires and the daemon replaces the whole browser.
export const BROWSER_RESTARTS = 3;
export const BROWSER_RESTART_WINDOW_MS = 5 * 60_000;
const BROWSER_RESTART_PAUSE_MS = [0, 1000, 3000] as const;
// The browser process must answer a request that changes nothing this often, within the
// second figure; two misses in a row mean it hangs.
export const BROWSER_LIVENESS_MS = 5000;
const BROWSER_LIVENESS_ANSWER_MS = 4000;
const BROWSER_LIVENESS_MISSES = 2;

// Docker's memory limit for the cell: its OOM kills are counted here.
async function cgroupOomKills(): Promise<number> {
  const events = await readFile("/sys/fs/cgroup/memory.events", "utf8");
  return Number(/^oom_kill (\d+)$/mu.exec(events)?.[1] ?? 0);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(new BrowserRuntimeError("closed"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function exitDetail(exit: BrowserProcessExit | undefined): string | undefined {
  if (!exit) return undefined;
  return exit.signal ? `exited on ${exit.signal}` : `exited with code ${exit.code ?? "unknown"}`;
}

export class BrowserRuntimeError extends Error {
  constructor(readonly reason: "closed" | "startup" | "shutdown") {
    super(`Browser runtime refused: ${reason}`);
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new BrowserRuntimeError("closed");
  return value;
}

export interface BrowserRuntimeDependencies {
  readonly driver?: BrowserProcessDriver;
  readonly prepare?: typeof prepareBrowserRuntime;
  readonly probe?: BrowserReadinessProbe;
  readonly listen?: (server: Server, signal: AbortSignal) => Promise<void>;
  readonly oomKills?: () => Promise<number>;
  readonly releaseLocks?: (signal: AbortSignal) => Promise<void>;
  // One line per supervision event, for the container log: never page data.
  readonly log?: (line: string) => void;
}

function listen(server: Server, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      server.off("error", failed);
      signal.removeEventListener("abort", failed);
    };
    const failed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      server.close(() => {});
      reject(new BrowserRuntimeError("startup"));
    };
    server.once("error", failed);
    signal.addEventListener("abort", failed, { once: true });
    if (signal.aborted) return failed();
    server.listen(7700, "0.0.0.0", () => {
      if (settled) {
        server.close(() => {});
        return;
      }
      settled = true;
      cleanup();
      resolve();
    });
  });
}

export class BrowserRuntime {
  readonly instance = randomUUID();
  readonly #retirement = Promise.withResolvers<void>();
  readonly retired = this.#retirement.promise;
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #processes: BrowserProcesses;
  readonly #dependencies: Readonly<BrowserRuntimeDependencies>;
  readonly #config: BrowserRuntimeConfig;
  #native?: BrowserNative;
  #capture?: BrowserCapture;
  #targets?: BrowserTargets;
  #secrets?: BrowserSecrets;
  #browserGeneration = 0;
  #signInMode: BrowserSignInMode = "standard";
  #signInChanging = false;
  #accounts?: BrowserAccounts;
  #control?: BrowserControl;
  #downloads?: BrowserDownloadService;
  #uploads?: BrowserUploadService;
  #input?: BrowserInput;
  #observation?: BrowserObservation;
  #navigation?: BrowserNavigation;
  #http?: BrowserHttp;
  #started?: Promise<BrowserHttp>;
  #closing?: Promise<void>;
  #ready = false;
  #utilityRetirementUncertain = false;
  #gracefulBrowserClose = false;
  #supervisor: BrowserSupervisorState = { state: "starting", restarts: 0 };
  #restarts: number[] = [];
  #restarting?: Promise<void>;
  #oomKills = 0;
  #liveness?: ReturnType<typeof setInterval>;

  constructor(config: BrowserRuntimeConfig, dependencies: BrowserRuntimeDependencies = {}) {
    this.#config = Object.freeze({ ...config });
    this.#dependencies = Object.freeze({ ...dependencies });
    this.#processes = new BrowserProcesses(this.#config, {
      driver: dependencies.driver,
      fence: () => this.#fence(),
      drain: () => this.#drain(),
      gracefulChromiumClose: () => this.#gracefulBrowserClose,
      chromiumFailed: () => this.#browserFailed("browser_exited"),
      writersExited: () => {
        this.#downloads?.writersExited();
        this.#uploads?.readersExited();
      },
    });
    void this.retired.catch(() => {});
  }

  get ready(): boolean {
    return this.#ready && !this.#processes.closed && !this.#lifetime.signal.aborted;
  }

  get supervisor(): BrowserSupervisorState {
    return structuredClone(this.#supervisor);
  }

  retirement(): Promise<void> | undefined {
    return this.#processes.closed ? this.#processes.stop() : undefined;
  }

  start(): Promise<BrowserHttp> {
    if (this.#started) return this.#started;
    const completion = Promise.withResolvers<BrowserHttp>();
    this.#started = completion.promise;
    void this.#start().then(completion.resolve, completion.reject);
    return completion.promise;
  }

  stop(): Promise<void> {
    return this.#processes.stop();
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    const completion = Promise.withResolvers<void>();
    this.#closing = completion.promise;
    void (async () => {
      try {
        await this.stop();
      } finally {
        await this.#http?.close();
      }
    })().then(completion.resolve, completion.reject);
    return completion.promise;
  }

  #check(): void {
    if (this.#processes.closed || this.#lifetime.signal.aborted)
      throw new BrowserRuntimeError("closed");
  }

  async #step<Value>(operation: () => Promise<Value>): Promise<Value> {
    this.#check();
    const pending = Promise.resolve().then(() => {
      this.#check();
      return operation();
    });
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      (error: unknown) => {
        if (
          (error instanceof BrowserPreparationError && error.retirementUncertain) ||
          error instanceof BrowserReadinessRetirementError
        )
          this.#utilityRetirementUncertain = true;
        this.#pending.delete(pending);
      },
    );
    const cancelled = Promise.withResolvers<never>();
    const abort = () => cancelled.reject(new BrowserRuntimeError("closed"));
    this.#lifetime.signal.addEventListener("abort", abort, { once: true });
    if (this.#lifetime.signal.aborted) abort();
    try {
      const value = await Promise.race([pending, cancelled.promise]);
      this.#check();
      return value;
    } finally {
      this.#lifetime.signal.removeEventListener("abort", abort);
    }
  }

  async #wait(stage: BrowserReadinessStage, probe: BrowserReadinessProbe): Promise<void> {
    await this.#until(() => probe(stage, this.#lifetime.signal));
  }

  async #until(probe: () => Promise<boolean>): Promise<void> {
    const deadline = performance.now() + BROWSER_READINESS_MS;
    while (performance.now() < deadline) {
      if (await this.#step(probe)) return;
      await this.#step(() => sleep(50, undefined, { signal: this.#lifetime.signal }));
    }
    throw new BrowserRuntimeError("startup");
  }

  async #start(): Promise<BrowserHttp> {
    const deadline = setTimeout(() => {
      void this.stop().catch(() => {});
    }, BROWSER_RUNTIME_START_MS);
    const fatal = () => {
      void this.stop().catch(() => {});
    };
    let stage = "preparation";
    try {
      this.#check();
      await this.#step(() =>
        (this.#dependencies.prepare ?? prepareBrowserRuntime)(this.#config, this.#lifetime.signal),
      );
      const probe = this.#dependencies.probe ?? browserReadiness(this.#config);
      stage = "the display";
      await this.#step(() => this.#processes.start("display"));
      await this.#wait("display", probe);
      await this.#wait("monitor", probe);
      stage = "the session bus";
      await this.#step(() => this.#processes.start("dbus"));
      await this.#wait("dbus", probe);
      stage = "the window manager";
      await this.#step(() => this.#processes.start("windowManager"));
      await this.#wait("windowManager", probe);
      stage = "native input";
      const nativeChannels = await this.#step(() => this.#processes.start("xhelper"));
      if (!nativeChannels.input || !nativeChannels.output) throw new BrowserRuntimeError("startup");
      this.#native = new BrowserNative({
        input: nativeChannels.input,
        output: nativeChannels.output,
        scale: this.#config.scale,
        onFatal: fatal,
      });
      const native = this.#native;
      await this.#step(() => native.ready);
      await this.#step(() => native.command("ping", {}, this.#lifetime.signal));
      stage = "screen capture";
      const captureChannels = await this.#step(() => this.#processes.start("capture"));
      if (!captureChannels.input || !captureChannels.output)
        throw new BrowserRuntimeError("startup");
      this.#capture = new BrowserCapture({
        input: captureChannels.input,
        output: captureChannels.output,
        onFatal: fatal,
      });
      const capture = this.#capture;
      await this.#step(() => capture.ready);
      stage = "the network forwarder";
      await this.#step(() => this.#processes.start("forwarder"));
      await this.#wait("forwarder", probe);
      stage = "the stream";
      await this.#step(() => this.#processes.start("stream"));
      await this.#step(() => this.#processes.start("streamProxy"));
      await this.#wait("stream", probe);
      stage = "Chromium";
      const chromium = await this.#step(() => this.#processes.start("chromium"));
      await this.#attachBrowser(chromium);
      stage = "the control service";
      const runtime = this;
      this.#http = new BrowserHttp({
        workWindow: new WorkWindow({
          ...process.env,
          DISPLAY: ":1",
          GDK_SCALE: String(this.#config.scale),
          HOME: "/home/browser",
        }),
        config: this.#config,
        instance: this.instance,
        control: required(this.#control),
        get targets() {
          return required(runtime.#targets);
        },
        get input() {
          return required(runtime.#input);
        },
        get observation() {
          return required(runtime.#observation);
        },
        get navigation() {
          return runtime.#navigation;
        },
        get downloads() {
          return runtime.#downloads;
        },
        get uploads() {
          return runtime.#uploads;
        },
        get accounts() {
          return runtime.#accounts;
        },
        signIn: {
          state: () => ({ mode: this.#signInMode, changing: this.#signInChanging }),
          set: (permit, mode, signal) => this.#signIn(permit, mode, signal),
        },
        ready: () => this.ready,
        supervisor: () => this.supervisor,
        fence: () => {
          void this.stop().catch(() => {});
        },
        stop: () => this.stop(),
        retirement: () => this.retirement(),
      });
      const service = this.#http;
      service.server.on("error", fatal);
      await this.#step(() =>
        (this.#dependencies.listen ?? listen)(service.server, this.#lifetime.signal),
      );
      this.#oomKills = await this.#countOomKills();
      this.#ready = true;
      this.#supervisor = { ...this.#supervisor, state: "running" };
      this.#watch();
      return service;
    } catch {
      this.#log(`could not start ${stage}`);
      try {
        await this.stop();
      } finally {
        await this.#http?.close();
      }
      throw new BrowserRuntimeError("startup");
    } finally {
      clearTimeout(deadline);
    }
  }

  async #attachBrowser(chromium: BrowserProcessChannels, restoring = false): Promise<void> {
    const generation = ++this.#browserGeneration;
    const fatal = (error?: unknown) => {
      if (generation !== this.#browserGeneration) return;
      const cause = error instanceof BrowserTargetError ? error.cause : undefined;
      this.#browserFailed(cause === "control timeout" ? "unresponsive" : "control_lost", cause);
    };
    const native = required(this.#native);
    const capture = required(this.#capture);
    if (!chromium.input || !chromium.output) throw new BrowserRuntimeError("startup");
    this.#targets = new BrowserTargets(pipeTransport(chromium.input, chromium.output), {
      downloadDir: BROWSER_DOWNLOAD_DIR,
      uploadDir: BROWSER_UPLOAD_DIR,
      onFatal: fatal,
      onCrash: (crash) => {
        if (generation !== this.#browserGeneration) return;
        void this.#failure("tab_crashed", `renderer ${crash.status}`, crash.reloaded).then(
          (failure) =>
            this.#log(
              `a tab's renderer crashed (${failure.detail}); ${crash.reloaded ? "reloading the tab" : "it keeps crashing, left on its error page"}`,
            ),
        );
      },
      downloads: {
        owns: (guid) =>
          generation === this.#browserGeneration && (this.#downloads?.owns(guid) ?? false),
        begin: (params) => {
          if (generation !== this.#browserGeneration) return;
          if (!this.#downloads) {
            fatal();
            return;
          }
          this.#downloads.begin(params);
        },
        progress: (params) => {
          if (generation !== this.#browserGeneration) return;
          if (!this.#downloads) {
            fatal();
            return;
          }
          this.#downloads.progress(params);
        },
      },
    });
    const targets = this.#targets;
    await this.#step(() => targets.start());
    await this.#until(async () => targets.tabs().some((candidate) => candidate.ready));
    const tab = targets.tabs().find((candidate) => candidate.ready);
    if (!tab) throw new BrowserRuntimeError("startup");
    if (!restoring) {
      await this.#step(() => targets.maximize(tab.id, this.#lifetime.signal));
      await this.#step(() => targets.activate(tab.id, this.#lifetime.signal));
      const document = targets.documents(tab.id).find((candidate) => !candidate.frame);
      if (!document) throw new BrowserRuntimeError("startup");
      await this.#step(() =>
        targets.command(document, "Page.bringToFront", {}, this.#lifetime.signal),
      );
    }
    const secrets = new BrowserSecrets(targets, native);
    this.#secrets = secrets;
    this.#control ??= new BrowserControl({
      browserCellId: this.#config.browserCellId,
      parentCellId: this.#config.parentCellId,
      instance: this.instance,
      clearSelections: (signal) => {
        if (this.#signInMode !== "standard" || this.#signInChanging)
          throw new BrowserRuntimeError("closed");
        required(this.#targets).clearFileChooser();
        return required(this.#secrets).clearSelections(signal);
      },
      secretPages: (signal) => required(this.#secrets).secretPages(signal),
      reload: (page, signal) => required(this.#secrets).reload(page, signal),
    });
    this.#downloads = new BrowserDownloadService({
      config: this.#config,
      instance: this.instance,
      control: this.#control,
      targets,
      fence: fatal,
    });
    this.#uploads = new BrowserUploadService({
      config: this.#config,
      instance: this.instance,
      control: this.#control,
      targets,
    });
    const geometry = new BrowserGeometry(targets, native, this.#config.scale);
    this.#input = new BrowserInput({
      control: this.#control,
      targets,
      geometry,
      secrets,
      native,
      scale: this.#config.scale,
      onFatal: () => {
        void this.stop().catch(() => {});
      },
    });
    this.#observation = new BrowserObservation({
      control: this.#control,
      targets,
      geometry,
      secrets,
      native,
      capture,
      scale: this.#config.scale,
    });
    this.#navigation = new BrowserNavigation(this.#control, targets);
    this.#accounts = new BrowserAccounts(required(this.#targets));
  }

  // The supervisor's one decision about a failed Chromium: restart it in place, or retire the
  // runtime when it is not running normally or has failed too often. True while a restart owns it.
  #browserFailed(kind: BrowserFailureKind, cause?: string): boolean {
    if (this.#restarting) return true;
    if (this.#processes.closed || this.#lifetime.signal.aborted) return false;
    const now = performance.now();
    this.#restarts = this.#restarts.filter((at) => now - at < BROWSER_RESTART_WINDOW_MS);
    if (
      !this.#ready ||
      this.#signInMode !== "standard" ||
      this.#signInChanging ||
      this.#restarts.length >= BROWSER_RESTARTS
    ) {
      void this.#failure(kind, cause, false).then((failure) =>
        this.#log(`the browser failed (${failure.detail}); stopping`),
      );
      void this.stop().catch(() => {});
      return false;
    }
    this.#restarts.push(now);
    const task = this.#restartBrowser(kind, cause, this.#restarts.length);
    this.#restarting = task;
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
    return true;
  }

  // Revokes the failed browser's authority, waits until its whole process group has exited, then
  // starts Chromium on the same profile, blank: a restored session leaves keyboard focus outside
  // the page, and a page that crashed the browser must not open again by itself.
  async #restartBrowser(kind: BrowserFailureKind, cause: string | undefined, attempt: number) {
    this.#ready = false;
    this.#browserGeneration++;
    clearInterval(this.#liveness);
    this.#supervisor = { ...this.#supervisor, state: "restarting" };
    const downloads = this.#downloads;
    const uploads = this.#uploads;
    const armed = downloads?.binding;
    try {
      this.#targets?.close();
    } catch {}
    const draining = Promise.all([
      this.#observation?.close(),
      this.#navigation?.close(),
      downloads?.close(),
      uploads?.close(),
      this.#input?.close(),
    ]);
    void draining.catch(() => {});
    try {
      await pause(BROWSER_RESTART_PAUSE_MS[attempt - 1] ?? 3000, this.#lifetime.signal);
      const channels = await this.#processes.replaceChromium(
        browserProcessSpecs(this.#config).chromium,
        () => false,
        false,
        {
          beforeStart: () =>
            (
              this.#dependencies.releaseLocks ??
              ((signal) => releaseProfileLocks(BROWSER_PROFILE_DIR, signal))
            )(this.#lifetime.signal),
        },
      );
      downloads?.writersExited();
      uploads?.readersExited();
      const failure = await this.#failure(kind, cause, true);
      this.#log(
        `the browser failed (${failure.detail}); restarting it in place (${attempt} of ${BROWSER_RESTARTS})`,
      );
      await draining;
      this.#check();
      await this.#attachBrowser(channels);
      this.#check();
      // From here a failure is the new browser's own.
      this.#restarting = undefined;
      if (required(this.#targets).closed) throw new BrowserRuntimeError("startup");
      this.#ready = true;
      this.#supervisor = {
        ...this.#supervisor,
        state: "running",
        restarts: this.#supervisor.restarts + 1,
      };
      this.#watch();
      // The same grant collects downloads from the new browser; a refused grant leaves them off.
      if (armed) void this.#downloads?.arm(armed, this.#lifetime.signal).catch(() => {});
    } catch {
      if (this.#lifetime.signal.aborted) return;
      this.#log("the browser could not be restarted in place; stopping");
      void this.stop().catch(() => {});
    }
  }

  // A hung browser keeps its pipe open: ask it something harmless, and restart it when it
  // misses twice in a row.
  #watch(): void {
    const generation = this.#browserGeneration;
    const targets = this.#targets;
    let misses = 0;
    let asking = false;
    clearInterval(this.#liveness);
    this.#liveness = setInterval(() => {
      if (asking || generation !== this.#browserGeneration || !targets || targets.closed) return;
      asking = true;
      const expiry = new AbortController();
      const deadline = setTimeout(() => expiry.abort(), BROWSER_LIVENESS_ANSWER_MS);
      targets
        .ping(expiry.signal)
        .then(
          () => {
            misses = 0;
          },
          () => {
            if (generation !== this.#browserGeneration || targets.closed) return;
            misses += 1;
            if (misses >= BROWSER_LIVENESS_MISSES)
              this.#browserFailed("unresponsive", "no answer to a liveness check");
          },
        )
        .finally(() => {
          clearTimeout(deadline);
          asking = false;
        });
    }, BROWSER_LIVENESS_MS);
    this.#liveness.unref?.();
  }

  // Records what failed, naming the exit status and a new out-of-memory kill when there was one.
  async #failure(kind: BrowserFailureKind, cause: string | undefined, recovered: boolean) {
    const oomKills = await this.#countOomKills();
    const oom = oomKills > this.#oomKills;
    this.#oomKills = Math.max(this.#oomKills, oomKills);
    const exit =
      kind === "tab_crashed" ? undefined : exitDetail(this.#processes.takeChromiumExit());
    const detail =
      [cause, exit, oom ? "out of memory" : undefined].filter(Boolean).join(", ") || kind;
    const failure = { kind, detail, recovered, at: new Date().toISOString() };
    this.#supervisor = { ...this.#supervisor, lastFailure: failure };
    return failure;
  }

  async #countOomKills(): Promise<number> {
    try {
      return await (this.#dependencies.oomKills ?? cgroupOomKills)();
    } catch {
      return this.#oomKills;
    }
  }

  #log(line: string): void {
    try {
      (this.#dependencies.log ?? ((text) => process.stderr.write(`${text}\n`)))(
        `browserd: ${line}`,
      );
    } catch {}
  }

  async #signIn(permit: BrowserManualPermit, mode: BrowserSignInMode, signal: AbortSignal) {
    this.#check();
    if (this.#signInChanging) throw new BrowserRuntimeError("closed");
    const lease = required(this.#control).admitManual(permit);
    try {
      signal.throwIfAborted();
      lease.check();
      if (mode === this.#signInMode) return { mode, changing: false };
      this.#signInChanging = true;
      // From this point finish the physical transition even if the HTTP caller leaves.
      // A new control request still cannot grant agent access while changing/signing in.
      const task = this.#replaceBrowser(mode);
      this.#pending.add(task);
      try {
        await task;
      } finally {
        this.#pending.delete(task);
      }
      lease.check();
      signal.throwIfAborted();
      return { mode: this.#signInMode, changing: false };
    } finally {
      lease.finish();
    }
  }

  async #replaceBrowser(mode: BrowserSignInMode): Promise<void> {
    const downloads = this.#downloads;
    const uploads = this.#uploads;
    const draining = Promise.all([
      this.#observation?.close(),
      this.#navigation?.close(),
      downloads?.close(),
      uploads?.close(),
    ]);
    void draining.catch(() => {});
    try {
      const channels = await this.#processes.replaceChromium(
        browserSignInSpec(this.#config, mode === "signin"),
        async () => {
          this.#browserGeneration++;
          if (this.#signInMode === "standard") return this.#targets?.retire() ?? false;
          // SIGTERM can lose Chromium's current session even though it flushes cookies.
          // Use its normal Quit command so the final tabs are saved, without reattaching CDP.
          const { windows } = await required(this.#native).command(
            "windows",
            {},
            this.#lifetime.signal,
          );
          const window = windows.find((candidate) => candidate.active) ?? windows[0];
          if (!window) throw new BrowserRuntimeError("closed");
          await required(this.#native).command(
            "activate",
            { window: window.id },
            this.#lifetime.signal,
          );
          await required(this.#native).command(
            "userKeys",
            { combo: ["Alt_L", "f"] },
            this.#lifetime.signal,
          );
          await sleep(100, undefined, { signal: this.#lifetime.signal });
          await required(this.#native).command("userKeys", { combo: ["x"] }, this.#lifetime.signal);
          return true;
        },
        this.#signInMode === "signin",
      );
      downloads?.writersExited();
      uploads?.readersExited();
      await draining;
      this.#check();
      if (mode === "standard") {
        await this.#input?.close();
        await this.#attachBrowser(channels, true);
      } else {
        // A spawned process is not yet a usable window. Keep native input fenced
        // until the replacement window is present; no page inspection is involved.
        await this.#until(async () => {
          const { windows } = await required(this.#native).command(
            "windows",
            {},
            this.#lifetime.signal,
          );
          return windows.some((window) => window.active);
        });
      }
      // In sign-in mode the old input owner serves native manual input only. Its
      // closed targets cannot observe anything; all managed HTTP routes are fenced.
      this.#signInMode = mode;
    } catch (error) {
      if (error instanceof BrowserProcessError && error.reason === "busy") throw error;
      void this.stop().catch(() => {});
      throw new BrowserRuntimeError("startup");
    } finally {
      this.#signInChanging = false;
    }
  }

  #fence(): void {
    this.#ready = false;
    clearInterval(this.#liveness);
    this.#supervisor = { ...this.#supervisor, state: "stopped" };
    // Revoke target/broker authority before aborting admitted requests. A single
    // terminal Browser.close may then flush the owned profile; no further input is admitted.
    let failed = false;
    try {
      this.#gracefulBrowserClose = this.#targets?.retire() ?? false;
    } catch {
      failed = true;
    }
    this.#lifetime.abort();
    void this.#processes.stop().then(this.#retirement.resolve, this.#retirement.reject);
    for (const close of [
      () => {
        void this.#control?.close().catch(() => {});
      },
      () => {
        void this.#input?.close().catch(() => {});
      },
      () => {
        void this.#observation?.close().catch(() => {});
      },
      () => {
        void this.#navigation?.close().catch(() => {});
      },
      () => {
        void this.#downloads?.close().catch(() => {});
      },
      () => {
        void this.#uploads?.close().catch(() => {});
      },
      () => this.#targets?.close(),
      () => this.#native?.close(),
      () => this.#capture?.close(),
    ]) {
      try {
        close();
      } catch {
        failed = true;
      }
    }
    if (failed) throw new BrowserRuntimeError("shutdown");
  }

  async #drain(): Promise<void> {
    const results = await Promise.allSettled([
      ...this.#pending,
      Promise.resolve().then(() => this.#control?.close()),
      Promise.resolve().then(() => this.#input?.close()),
      Promise.resolve().then(() => this.#observation?.close()),
      Promise.resolve().then(() => this.#navigation?.close()),
      Promise.resolve().then(() => this.#downloads?.close()),
      Promise.resolve().then(() => this.#uploads?.close()),
    ]);
    const ownerResults = results.slice(-6);
    if (
      this.#utilityRetirementUncertain ||
      ownerResults.some((result) => result.status === "rejected")
    )
      throw new BrowserRuntimeError("shutdown");
  }
}
