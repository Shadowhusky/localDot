import {
  type AppUpdateAttempt,
  AppUpdatePreferences,
  type AppUpdateProgress,
  AppUpdateRecord,
  type AppUpdateStatus,
  compareReleaseVersions,
  DEFAULT_APP_UPDATES,
  type ReleaseNote,
  type UpdateInstallStage,
  type UpdateProblem,
  type UpdateProgressLine,
} from "../../../../packages/protocol/src/app-update.ts";
import { progressAfter, READY_SHARE, reasonFor, UpdateFailure } from "./progress.ts";

const HOUR = 3_600_000;
const READY = "Ready to install";
const READY_LOW_DISK =
  "Ready to install · low on disk space, so installing downloads the computer first";
const WATCH_MS = 1000;
// An installer that has said nothing new for this long, before it has touched anything, is stuck.
const INSTALL_STALL_MS = 20 * 60_000;
// A finished installer has restarted this daemon by now.
const RESTART_GRACE_MS = 60_000;
const UNTOUCHED: readonly UpdateInstallStage[] = ["prepare", "verify", "images"];

export interface PreparedUpdate {
  // The computer images were left for the installer, because free disk space was short.
  imagesDeferred?: boolean;
}
export interface InstallerState {
  stage: UpdateInstallStage;
  problem?: UpdateProblem;
  restored: boolean;
  running: boolean;
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
  // Why installing has to wait. Unless told not to hold, a null also holds localDot for the install.
  installWait?(hold?: boolean): string | null | Promise<string | null>;
  // The independent installer's own record of how it is getting on.
  installer?: {
    read(): Promise<InstallerState | null>;
    reset(): Promise<void>;
    cancel(): void;
  };
  // This version is in, for good: what was kept in case it wasn't can go.
  installed?(): Promise<void>;
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
const sentences = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" ");
const problemOf = (error: unknown) => (error instanceof UpdateFailure ? error.problem : undefined);

function installProgress(version: string, stage: UpdateInstallStage): AppUpdateProgress {
  const name = shown(version);
  switch (stage) {
    case "verify":
      return { step: "install", value: 0.96, detail: "Checking the download once more" };
    case "images":
      return { step: "install", value: 0.96, detail: "Downloading the computer" };
    case "stop":
      return { step: "restart", value: 0.97, detail: "Restarting localDot" };
    case "start":
      return { step: "restart", value: 0.98, detail: `Starting localDot ${name}` };
    case "check":
    case "done":
      return { step: "restart", value: 0.99, detail: `Checking localDot ${name}` };
    default:
      return { step: "install", value: READY_SHARE, detail: `Getting ready to install localDot ${name}` };
  }
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
  #progress: AppUpdateProgress | null = null;
  #readyDetail = READY;
  #notes: ReleaseNote[] = [];
  // The version this one replaced, known only on the first start after an update.
  #previous: string | null = null;
  // The user's Update now is under way, through to the install.
  #wanted = false;
  #flight: Promise<void> | undefined;
  #writes: Promise<void> = Promise.resolve();
  #abort = new AbortController();
  #timer?: ReturnType<typeof setTimeout>;
  #watching?: ReturnType<typeof setInterval>;
  #restartWait?: ReturnType<typeof setTimeout>;
  #ready: Promise<void>;
  constructor(
    private readonly host: AppUpdaterHost | null,
    private readonly unsupported: AppUpdateStatus["unsupported"] = null,
  ) {
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
  // An installer started before this daemon may still be at work: it is joined, not judged.
  async #settleAttempt() {
    try {
      const attempt = await this.host?.attempts?.read();
      if (!attempt) return;
      const state = (await this.host?.installer?.read().catch(() => null)) ?? null;
      if (state?.running) {
        this.#phase = "installing";
        this.#wanted = true;
        this.#progress = installProgress(attempt.version, state.stage);
        this.#watch(attempt.version);
        return;
      }
      await this.#conclude(attempt.version, state);
    } catch {}
  }
  // The installer is over, and it restarted us, or never got that far.
  async #conclude(version: string, state: InstallerState | null) {
    const host = this.host;
    if (!host) return;
    this.#stopWatching();
    this.#wanted = false;
    await host.attempts?.save(null);
    const available = this.#record.availableVersion;
    this.#phase =
      available && (await host.prepared(available).catch(() => false)) ? "ready" : "idle";
    if (version === host.version) {
      this.#progress = null;
      await host.installed?.().catch(() => {});
      return;
    }
    const name = shown(version);
    if (state?.problem === "interrupted")
      this.#error = `The update to localDot ${name} was interrupted, so your previous version was restored.`;
    else if (state?.problem === "checks")
      this.#error = `localDot ${name} started but failed its checks, so your previous version was restored.`;
    else if (state && !state.restored && state.stage === "failed") {
      this.#error = sentences(
        `localDot ${name} couldn't be installed, so nothing has changed.`,
        reasonFor(state.problem),
      );
      this.#progress = { step: "install", value: null, detail: null };
      return;
    } else this.#error = `localDot ${name} didn't start, so your previous version was restored.`;
    this.#progress = { step: "restart", value: null, detail: null };
  }
  #stopWatching() {
    clearInterval(this.#watching);
    clearTimeout(this.#restartWait);
    this.#watching = undefined;
    this.#restartWait = undefined;
  }
  // Follows the installer through the status file it keeps, and gives up on one stuck before it
  // has touched anything. Past that it restarts this daemon, and bounds its own waits.
  #watch(version: string) {
    const installer = this.host?.installer;
    if (!installer || this.#watching) return;
    // One this daemon started reports its own exit; one it joined can only be read.
    const adopted = !this.#installStarted;
    let stage: UpdateInstallStage | undefined,
      since = this.#now(),
      reading = false;
    this.#watching = setInterval(() => {
      if (reading) return;
      reading = true;
      void installer
        .read()
        .then(async (state) => {
          if (this.#phase !== "installing" || !this.#watching) return;
          if (state && state.stage !== stage) {
            stage = state.stage;
            since = this.#now();
            this.#progress = installProgress(version, state.stage);
          }
          if (adopted && state && !state.running) return this.#conclude(version, state);
          if (
            state?.running &&
            UNTOUCHED.includes(state.stage) &&
            this.#now() - since >= INSTALL_STALL_MS
          ) {
            this.#stalled = true;
            installer.cancel();
          }
        })
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    }, WATCH_MS);
    this.#watching.unref?.();
  }
  #stalled = false;
  #installStarted = false;
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
      updating: this.#wanted,
      unsupported: this.unsupported,
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
    this.#stopWatching();
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
  /** Update now, from wherever things stand and from any device: it asks the channel, downloads
   * what is missing and installs. Resolves once under way; a second call joins the first. */
  async update() {
    await this.#ready;
    const host = this.host;
    if (!host?.install) throw new Error("Updates work in the installed app.");
    if (this.#abort.signal.aborted || this.#underway()) return;
    const wait = await host.installWait?.(false);
    // Downloading disturbs nothing, so it goes on, ready for when the work is done.
    if (wait) {
      void this.check()
        .then(() => this.download())
        .catch(() => {});
      throw new Error(wait);
    }
    if (this.#underway()) return;
    this.#wanted = true;
    this.#error = null;
    const before = this.#flight;
    this.#flight = this.#carryOut(before).finally(() => {
      this.#flight = undefined;
      if (this.#phase !== "installing") this.#wanted = false;
    });
    void this.#flight;
  }
  #underway() {
    return this.#phase === "installing" || this.#wanted;
  }
  async #carryOut(before: Promise<void> | undefined) {
    await before?.catch(() => {});
    if (this.#abort.signal.aborted) return;
    // A prepared version may have been overtaken, and the installer refuses one the signed
    // catalog no longer names, so the channel is asked every time.
    await this.#check();
    if (this.#abort.signal.aborted) return;
    const version = this.#record.availableVersion;
    if (!version) return;
    if (this.#phase !== "ready" && !this.#error) await this.#download();
    // A check that failed offline still leaves a download the installer can judge for itself.
    if (this.#phase === "ready") await this.#beginInstall(version);
  }
  async #beginInstall(version: string) {
    const host = this.host;
    if (!host?.install) return;
    const wait = await host.installWait?.();
    if (wait) {
      this.#error = wait;
      this.#progress = null;
      return;
    }
    this.#phase = "installing";
    this.#error = null;
    this.#stalled = false;
    this.#installStarted = true;
    this.#progress = {
      step: "install",
      value: READY_SHARE,
      detail: `Installing localDot ${shown(version)}`,
    };
    await host.installer?.reset().catch(() => {});
    await host.attempts?.save({ v: 1, version }).catch(() => {});
    this.#watch(version);
    // Deliberately not in #flight: the independent updater must outlive daemon shutdown.
    void host.install(version).then(
      () => {
        this.#restartWait = setTimeout(
          () =>
            void this.#installFailed(
              version,
              new Error("installer finished"),
              "The installer finished but localDot didn't restart. Restart localDot to finish.",
            ),
          RESTART_GRACE_MS,
        );
        this.#restartWait.unref?.();
      },
      (error: unknown) => this.#installFailed(version, error),
    );
  }
  async #installFailed(version: string, error: unknown, words?: string) {
    const host = this.host;
    if (!host || this.#phase !== "installing") return;
    this.#stopWatching();
    const state = (await host.installer?.read().catch(() => null)) ?? null;
    await host.attempts?.save(null).catch(() => {});
    const available = this.#record.availableVersion;
    this.#phase =
      available && (await host.prepared(available).catch(() => false)) ? "ready" : "idle";
    this.#wanted = false;
    this.#progress = { step: "install", value: null, detail: null };
    this.#error =
      words ??
      (this.#stalled
        ? `localDot ${shown(version)} stopped responding while installing, so nothing has changed. Try again.`
        : sentences(
            `localDot ${shown(version)} couldn't be installed, so nothing has changed.`,
            reasonFor(state?.problem ?? problemOf(error)),
          ));
  }
  // Kept for pages from before Update now; they only offered it once a download was ready.
  async install() {
    return this.update();
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
        (this.#record.preferences.automaticDownloads || this.#wanted)
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
  async #download(): Promise<void> {
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
    } catch (error) {
      this.#phase = "idle";
      if (this.#abort.signal.aborted) return;
      const problem = problemOf(error);
      // The channel moved on since the check, and only names its newest: follow it.
      if (problem === "channel" && !this.#moved) {
        this.#moved = true;
        this.#record.availableVersion = null;
        try {
          return await this.#check();
        } finally {
          this.#moved = false;
        }
      }
      this.#error = sentences(
        `localDot ${shown(version)} couldn't be downloaded, so nothing has changed.`,
        reasonFor(problem),
      );
      await this.#failed();
    }
  }
  #moved = false;
}
