import {
  type AppUpdateAttempt,
  AppUpdatePreferences,
  type AppUpdateProgress,
  AppUpdateRecord,
  type AppUpdateStatus,
  compareReleaseVersions,
  DEFAULT_APP_UPDATES,
  type ReleaseNote,
  type UpdateProgressLine,
} from "../../../../packages/protocol/src/app-update.ts";
import { progressAfter, READY_SHARE } from "./progress.ts";

const HOUR = 3_600_000;
const READY = "Ready to install";
const READY_LOW_DISK =
  "Ready to install · low on disk space, so installing downloads the computer first";

export interface PreparedUpdate {
  // The computer images were left for the installer, because free disk space was short.
  imagesDeferred?: boolean;
}
export interface AppUpdaterHost {
  version: string;
  installOnLaunchSupported?: boolean;
  compare?(a: string, b: string): number;
  read(): Promise<AppUpdateRecord | null>;
  save(record: AppUpdateRecord): Promise<void>;
  latest(signal: AbortSignal): Promise<string>;
  prepare(
    version: string,
    signal: AbortSignal,
    progress: (line: UpdateProgressLine) => void,
  ): Promise<PreparedUpdate | undefined>;
  prepared(version: string): Promise<boolean>;
  install?(version: string): Promise<void>;
  installWait?(): string | null | Promise<string | null>;
  // Newest first: notes after `after` up to `upTo`, or `upTo`'s own when `after` is unknown.
  notes?(after: string | null, upTo: string): Promise<ReleaseNote[]>;
  attempts?: {
    read(): Promise<AppUpdateAttempt | null>;
    save(attempt: AppUpdateAttempt | null): Promise<void>;
  };
  now?(): number;
  random?(): number;
}
// A source build is named by its commit.
const shown = (version: string) => (version.length === 40 ? version.slice(0, 8) : version);
/** One scheduler per daemon, not per tab/device. Cached discovery is not package trust. */
export class AppUpdater {
  #record: AppUpdateRecord = {
    v: 1,
    preferences: { ...DEFAULT_APP_UPDATES },
    checkedAt: null,
    nextCheckAt: 0,
    failures: 0,
    availableVersion: null,
    dismissedVersion: null,
  };
  #phase: AppUpdateStatus["phase"] = "idle";
  #admitting = false;
  #error: string | null = null;
  #progress: AppUpdateProgress | null = null;
  #readyDetail = READY;
  #notes: ReleaseNote[] = [];
  // The version this one replaced, known only on the first start after an update.
  #previous: string | null = null;
  #flight: Promise<void> | undefined;
  #writes: Promise<void> = Promise.resolve();
  #abort = new AbortController();
  #timer?: ReturnType<typeof setTimeout>;
  #ready: Promise<void>;
  constructor(private readonly host: AppUpdaterHost | null) {
    this.#ready = this.#load();
  }
  #compare(a: string, b: string) {
    return this.host?.compare?.(a, b) ?? compareReleaseVersions(a, b);
  }
  #now() {
    return this.host?.now?.() ?? Date.now();
  }
  #jitter(ms: number) {
    return Math.round(ms * (0.8 + (this.host?.random?.() ?? Math.random()) * 0.4));
  }
  async #load() {
    if (!this.host) return;
    try {
      const stored = await this.host.read();
      if (stored) this.#record = AppUpdateRecord.parse(stored);
      if (this.#record.installedVersion && this.#record.installedVersion !== this.host.version) {
        this.#previous = this.#record.installedVersion;
        this.#record.availableVersion = null;
        this.#record.dismissedVersion = null;
        this.#record.nextCheckAt = 0;
      }
      // A clock adjustment must not defer a check indefinitely.
      this.#record.nextCheckAt = Math.min(this.#record.nextCheckAt, this.#now() + 7.2 * HOUR);
      const version = this.#record.availableVersion;
      if (version && this.#compare(version, this.host.version) <= 0) {
        this.#record.availableVersion = null;
        this.#record.dismissedVersion = null;
      } else if (version && (await this.host.prepared(version))) this.#phase = "ready";
    } catch {
      this.#record.preferences = {
        automaticChecks: false,
        automaticDownloads: false,
        installOnLaunch: false,
      };
      this.#error = "Update settings couldn't be read. Check for updates to try again.";
    }
    await this.#settleAttempt();
    await this.#refreshNotes();
  }
  // An explicit install that left this same version running was rolled back.
  async #settleAttempt() {
    try {
      const attempt = await this.host?.attempts?.read();
      if (!attempt) return;
      await this.host?.attempts?.save(null);
      if (attempt.version === this.host?.version) return;
      this.#error = `localDot ${shown(attempt.version)} didn't start, so your previous version was restored.`;
      this.#progress = { step: "restart", value: null, detail: null };
    } catch {}
  }
  async #refreshNotes() {
    if (!this.host?.notes) return;
    const available = this.#record.availableVersion;
    try {
      this.#notes = available
        ? await this.host.notes(this.host.version, available)
        : await this.host.notes(this.#previous, this.host.version);
    } catch {
      this.#notes = [];
    }
  }
  #save() {
    const record = {
      ...structuredClone(this.#record),
      ...(this.host ? { installedVersion: this.host.version } : {}),
    };
    const next = this.#writes.catch(() => {}).then(() => this.host?.save(record));
    this.#writes = next;
    return next;
  }
  #shownProgress(): AppUpdateProgress | null {
    // A failed update keeps the progress of the step that failed.
    if (this.#error) return this.#progress;
    if (this.#phase === "ready")
      return { step: "install", value: READY_SHARE, detail: this.#readyDetail };
    return this.#phase === "downloading" || this.#phase === "installing" ? this.#progress : null;
  }
  async status(): Promise<AppUpdateStatus> {
    await this.#ready;
    return {
      supported: !!this.host,
      installOnLaunchSupported: this.host?.installOnLaunchSupported ?? true,
      currentVersion: this.host?.version ?? "Development",
      phase: this.#phase,
      preferences: { ...this.#record.preferences },
      checkedAt: this.#record.checkedAt,
      availableVersion: this.#record.availableVersion,
      dismissedVersion: this.#record.dismissedVersion,
      error: this.#error,
      progress: this.#shownProgress(),
      notes: this.#notes.map((note) => ({ ...note })),
    };
  }
  start() {
    if (!this.host || this.#timer || this.#abort.signal.aborted) return;
    const tick = () => {
      void this.check(false).finally(() => {
        if (!this.#abort.signal.aborted) this.#timer = setTimeout(tick, 60_000).unref();
      });
    };
    this.#timer = setTimeout(tick, this.#jitter(30_000)).unref();
  }
  async close() {
    clearTimeout(this.#timer);
    this.#abort.abort();
    await this.#flight;
    await this.#writes.catch(() => {});
  }
  async preferences(input: AppUpdatePreferences) {
    await this.#ready;
    this.#record.preferences = AppUpdatePreferences.parse(input);
    await this.#save();
  }
  async dismiss() {
    await this.#ready;
    this.#record.dismissedVersion = this.#record.availableVersion;
    await this.#save();
  }
  async install() {
    await this.#ready;
    const version = this.#record.availableVersion;
    if (!version || this.#phase !== "ready" || this.#flight || !this.host?.install)
      throw new Error("Download the update first.");
    // Admission may first end a finished task's wait; a second request meanwhile must not start
    // another installer. Nothing below may throw once admitted: localDot then refuses all work.
    if (this.#admitting) throw new Error("The update is already starting.");
    this.#admitting = true;
    let wait: string | null | undefined;
    try {
      wait = await this.host.installWait?.();
    } finally {
      this.#admitting = false;
    }
    if (wait) throw new Error(wait);
    this.#phase = "installing";
    this.#error = null;
    this.#progress = {
      step: "install",
      value: null,
      detail: `Installing localDot ${shown(version)}`,
    };
    await this.host.attempts?.save({ v: 1, version }).catch(() => {});
    // Deliberately not in #flight: the independent updater must outlive daemon shutdown.
    void this.host.install(version).catch(async () => {
      await this.host?.attempts?.save(null).catch(() => {});
      this.#phase = (await this.host?.prepared(version).catch(() => false)) ? "ready" : "idle";
      this.#error = `localDot ${shown(version)} couldn't be installed, so nothing has changed.`;
    });
  }
  async check(manual = true): Promise<void> {
    await this.#ready;
    if (!this.host || this.#abort.signal.aborted) return;
    if (this.#phase === "installing") return;
    if (this.#flight) return this.#flight;
    if (
      !manual &&
      (!this.#record.preferences.automaticChecks || this.#now() < this.#record.nextCheckAt)
    )
      return;
    this.#flight = this.#check().finally(() => {
      this.#flight = undefined;
    });
    return this.#flight;
  }
  async #check() {
    if (!this.host) return;
    const wasReady = this.#phase === "ready";
    this.#phase = "checking";
    this.#error = null;
    this.#progress = null;
    try {
      const version = await this.host.latest(
        AbortSignal.any([this.#abort.signal, AbortSignal.timeout(30_000)]),
      );
      this.#abort.signal.throwIfAborted();
      const newer = this.#compare(version, this.host.version) > 0;
      // Don't discard a discovered update on stale registry mirrors / a moved latest tag.
      if (
        newer &&
        (!this.#record.availableVersion ||
          this.#compare(version, this.#record.availableVersion) > 0)
      )
        this.#record.availableVersion = version;
      this.#record.checkedAt = this.#now();
      this.#record.failures = 0;
      this.#record.nextCheckAt = this.#now() + this.#jitter(6 * HOUR);
      this.#phase =
        this.#record.availableVersion && (await this.host.prepared(this.#record.availableVersion))
          ? "ready"
          : "idle";
      await this.#save();
      await this.#refreshNotes();
      if (
        this.#record.availableVersion &&
        this.#phase !== "ready" &&
        this.#record.preferences.automaticDownloads
      )
        await this.#download();
    } catch {
      if (!this.#abort.signal.aborted) {
        this.#error = this.#record.preferences.automaticChecks
          ? "Couldn't check for updates. We'll try again automatically."
          : "Couldn't check for updates. Try again when you’re online.";
        this.#phase = wasReady ? "ready" : "idle";
        await this.#failed();
      }
    }
  }
  async #failed() {
    this.#record.failures = Math.min(10, this.#record.failures + 1);
    this.#record.nextCheckAt =
      this.#now() + this.#jitter(Math.min(6 * HOUR, 300_000 * 2 ** (this.#record.failures - 1)));
    await this.#save().catch(() => {
      this.#error = "Update settings couldn't be saved. Try again.";
    });
  }
  async download() {
    await this.#ready;
    if (!this.host || this.#abort.signal.aborted) return;
    if (this.#phase === "installing") return;
    if (this.#flight) return this.#flight;
    if (!this.#record.availableVersion || this.#phase === "ready") return;
    this.#flight = this.#download().finally(() => {
      this.#flight = undefined;
    });
    return this.#flight;
  }
  async #download() {
    const version = this.#record.availableVersion;
    if (!version || !this.host) return;
    this.#phase = "downloading";
    this.#error = null;
    this.#progress = { step: "download", value: null, detail: "Downloading" };
    try {
      const prepared = await this.host.prepare(version, this.#abort.signal, (line) => {
        if (this.#phase === "downloading") this.#progress = progressAfter(this.#progress, line);
      });
      this.#abort.signal.throwIfAborted();
      if (!(await this.host.prepared(version))) throw new Error("Unconfirmed preparation");
      this.#readyDetail = prepared?.imagesDeferred ? READY_LOW_DISK : READY;
      this.#phase = "ready";
      await this.#refreshNotes();
    } catch {
      this.#phase = "idle";
      if (!this.#abort.signal.aborted) {
        this.#error = `localDot ${shown(version)} couldn't be downloaded, so nothing has changed.`;
        await this.#failed();
      }
    }
  }
}
