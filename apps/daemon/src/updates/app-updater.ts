import {
  AppUpdatePreferences,
  AppUpdateRecord,
  type AppUpdateStatus,
  compareReleaseVersions,
  DEFAULT_APP_UPDATES,
} from "../../../../packages/protocol/src/app-update.ts";

const HOUR = 3_600_000;
export interface AppUpdaterHost {
  version: string;
  installOnLaunchSupported?: boolean;
  compare?(a: string, b: string): number;
  read(): Promise<AppUpdateRecord | null>;
  save(record: AppUpdateRecord): Promise<void>;
  latest(signal: AbortSignal): Promise<string>;
  prepare(version: string, signal: AbortSignal): Promise<void>;
  prepared(version: string): Promise<boolean>;
  install?(version: string): Promise<void>;
  installWait?(): string | null;
  now?(): number;
  random?(): number;
}
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
  #error: string | null = null;
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
    const wait = this.host.installWait?.();
    if (wait) throw new Error(wait);
    this.#phase = "installing";
    this.#error = null;
    // Deliberately not in #flight: the independent updater must outlive daemon shutdown.
    void this.host.install(version).catch(() => {
      this.#phase = "idle";
      this.#error =
        "Installation didn't complete. Check for updates to retry, or run localdot up to recover.";
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
    try {
      await this.host.prepare(version, this.#abort.signal);
      this.#abort.signal.throwIfAborted();
      if (!(await this.host.prepared(version))) throw new Error("Unconfirmed preparation");
      this.#phase = "ready";
    } catch {
      this.#phase = "idle";
      if (!this.#abort.signal.aborted) {
        this.#error =
          "The update couldn't be downloaded or verified. Your current app is unchanged.";
        await this.#failed();
      }
    }
  }
}
