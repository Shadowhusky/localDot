import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
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
import { type BrowserProcessDriver, BrowserProcesses } from "./processes.ts";
import {
  type BrowserReadinessProbe,
  BrowserReadinessRetirementError,
  type BrowserReadinessStage,
  browserReadiness,
} from "./readiness.ts";
import {
  BROWSER_DOWNLOAD_DIR,
  BROWSER_UPLOAD_DIR,
  type BrowserRuntimeConfig,
} from "./runtime-config.ts";
import { BrowserSecrets } from "./secrets.ts";
import { BrowserTargets } from "./targets.ts";
import { BrowserUploadService } from "./upload-service.ts";

export const BROWSER_RUNTIME_START_MS = 60_000;
export const BROWSER_READINESS_MS = 15_000;

export class BrowserRuntimeError extends Error {
  constructor(readonly reason: "closed" | "startup" | "shutdown") {
    super(`Browser runtime refused: ${reason}`);
  }
}

export interface BrowserRuntimeDependencies {
  readonly driver?: BrowserProcessDriver;
  readonly prepare?: typeof prepareBrowserRuntime;
  readonly probe?: BrowserReadinessProbe;
  readonly listen?: (server: Server, signal: AbortSignal) => Promise<void>;
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

  constructor(config: BrowserRuntimeConfig, dependencies: BrowserRuntimeDependencies = {}) {
    this.#config = Object.freeze({ ...config });
    this.#dependencies = Object.freeze({ ...dependencies });
    this.#processes = new BrowserProcesses(this.#config, {
      driver: dependencies.driver,
      fence: () => this.#fence(),
      drain: () => this.#drain(),
      gracefulChromiumClose: () => this.#gracefulBrowserClose,
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
    try {
      this.#check();
      await this.#step(() =>
        (this.#dependencies.prepare ?? prepareBrowserRuntime)(this.#config, this.#lifetime.signal),
      );
      const probe = this.#dependencies.probe ?? browserReadiness(this.#config);
      await this.#step(() => this.#processes.start("display"));
      await this.#wait("display", probe);
      await this.#wait("monitor", probe);
      await this.#step(() => this.#processes.start("dbus"));
      await this.#wait("dbus", probe);
      await this.#step(() => this.#processes.start("windowManager"));
      await this.#wait("windowManager", probe);
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
      await this.#step(() => this.#processes.start("forwarder"));
      await this.#wait("forwarder", probe);
      await this.#step(() => this.#processes.start("stream"));
      await this.#step(() => this.#processes.start("streamProxy"));
      await this.#wait("stream", probe);
      const chromium = await this.#step(() => this.#processes.start("chromium"));
      if (!chromium.input || !chromium.output) throw new BrowserRuntimeError("startup");
      this.#targets = new BrowserTargets(pipeTransport(chromium.input, chromium.output), {
        downloadDir: BROWSER_DOWNLOAD_DIR,
        uploadDir: BROWSER_UPLOAD_DIR,
        onFatal: fatal,
        downloads: {
          owns: (guid) => this.#downloads?.owns(guid) ?? false,
          begin: (params) => {
            if (!this.#downloads) {
              fatal();
              return;
            }
            this.#downloads.begin(params);
          },
          progress: (params) => {
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
      await this.#step(() => targets.maximize(tab.id, this.#lifetime.signal));
      await this.#step(() => targets.activate(tab.id, this.#lifetime.signal));
      const document = targets.documents(tab.id).find((candidate) => !candidate.frame);
      if (!document) throw new BrowserRuntimeError("startup");
      await this.#step(() =>
        targets.command(document, "Page.bringToFront", {}, this.#lifetime.signal),
      );
      const secrets = new BrowserSecrets(targets, native);
      this.#control = new BrowserControl({
        browserCellId: this.#config.browserCellId,
        parentCellId: this.#config.parentCellId,
        instance: this.instance,
        clearSelections: (signal) => {
          targets.clearFileChooser();
          return secrets.clearSelections(signal);
        },
        secretPages: (signal) => secrets.secretPages(signal),
        reload: (page, signal) => secrets.reload(page, signal),
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
        onFatal: fatal,
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
      this.#http = new BrowserHttp({
        config: this.#config,
        instance: this.instance,
        control: this.#control,
        targets,
        input: this.#input,
        observation: this.#observation,
        navigation: this.#navigation,
        downloads: this.#downloads,
        uploads: this.#uploads,
        ready: () => this.ready,
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
      this.#ready = true;
      return service;
    } catch {
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

  #fence(): void {
    this.#ready = false;
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
