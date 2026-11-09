import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  type SpeechInstallJob,
  type SpeechInstallProblem,
  SpeechInstallStage,
  type SpeechInstallStatus,
  SpeechTierId,
  type SpeechTierId as TierId,
} from "../../../../packages/protocol/src/speech-install.ts";
import { freeBytes as measuredFree } from "../recorder/disk.ts";
import {
  catalogTarget,
  SPEECH_NOTICES,
  type SpeechBundle,
  type SpeechCatalog,
  type SpeechFilePin,
  type SpeechSource,
  type SpeechTierSpec,
} from "./speech-catalog.ts";
import {
  downloadVerified,
  SpeechDownloadProblem,
  sha256Of,
  type VerifiedDownload,
} from "./speech-download.ts";
import { type SpeechHost, speechThreads, tierFit, tierSpeed } from "./speech-fit.ts";

export class SpeechInstallRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechInstallRefused";
  }
}

// What the installer runs: the program, once, on a moment of silence, to know it starts here.
export type RunEngine = (
  binary: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<string>;

export interface InstalledSpeechModel {
  readonly binary: string;
  readonly args: readonly string[];
  readonly languages: readonly string[] | null;
}

export interface SpeechInstallerOptions {
  home: string;
  catalog: SpeechCatalog;
  host: SpeechHost;
  // A Whisper the person set up themselves, which this only ever reads about.
  handInstalled?(): { model: string; englishOnly: boolean } | null;
  // A model named in LOCALDOT_SPEECH_MODEL outranks what's installed here.
  handInstalledChosen?(): boolean;
  run?: RunEngine;
  fetch?: VerifiedDownload["fetch"];
  freeBytes?: (path: string) => number;
  waitMs?: number;
  attempts?: number;
  stallMs?: number;
  // A finished, failed or cancelled install changes what the voice route can use.
  changed?(): void;
}

const Pins = z.record(
  z.string().max(256),
  z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int() }),
);
const Installed = z.strictObject({
  tier: SpeechTierId,
  engineVersion: z.string().max(32),
  binary: z.string().max(256),
  engineFiles: Pins,
  modelFiles: Pins,
  flags: z.record(z.string().max(64), z.string().max(256)),
  args: z.array(z.string().max(128)).max(16),
  languages: z.array(z.string().max(8)).max(64).nullable(),
});
type Installed = z.infer<typeof Installed>;
const Under = z.strictObject({ tier: SpeechTierId, stage: SpeechInstallStage });

const SMOKE_MS = 120_000;
// A second of silence, 16 kHz mono 16-bit, for trying the program once.
const SILENCE_SAMPLES = 16_000;

const MB = 1024 ** 2;
const sizeWords = (bytes: number) =>
  bytes >= 1024 * MB
    ? `${(bytes / (1024 * MB)).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / MB))} MB`;

export function silentWav(samples = SILENCE_SAMPLES): Uint8Array {
  const out = new Uint8Array(44 + samples * 2);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  return out;
}

const hostRun: RunEngine = (binary, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        timeout: SMOKE_MS,
        signal,
        maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME },
      },
      (error, stdout, stderr) => (error ? reject(error) : resolve(`${stdout}\n${stderr}`)),
    );
  });

const extractTar = (
  archive: string,
  to: string,
  root: string,
  members: readonly string[],
  signal: AbortSignal,
) =>
  new Promise<void>((resolve, reject) => {
    execFile(
      "tar",
      [
        "-xf",
        archive,
        "-C",
        to,
        "--strip-components=1",
        "--no-same-owner",
        ...members.map((m) => `${root}/${m}`),
      ],
      { timeout: 10 * 60_000, signal, env: { PATH: "/usr/bin:/bin" }, maxBuffer: 256 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        reject(
          new InstallStep(
            "unpack",
            /bzip2/.test(String(stderr))
              ? "This computer needs the bzip2 tool to unpack the download. Install it, then Retry."
              : "The download couldn't be unpacked. Try again.",
          ),
        );
      },
    );
  });

class InstallStep extends Error {
  constructor(
    readonly problem: SpeechInstallProblem,
    message: string,
  ) {
    super(message);
  }
}

const sumBytes = (bundle: SpeechBundle) =>
  Object.values(bundle.files).reduce((total, file) => total + file.bytes, 0);
const bundleDownload = (bundle: SpeechBundle) => bundle.sources[0]?.bytes ?? 0;

function downloadWords(problem: SpeechDownloadProblem["problem"], what: string) {
  switch (problem) {
    case "disk":
      return "There isn't enough free disk space. Free some up, then Retry.";
    case "verify":
      return `The ${what} didn't match its checksum, so nothing was run. Retry, and tell us if it happens again.`;
    case "stalled":
      return `The ${what} download stopped moving. Check your connection, then Retry. What came through is kept.`;
    case "network":
      return `The ${what} couldn't be downloaded. Check your connection, then Retry. What came through is kept.`;
  }
}

// One-click speech: downloads the pinned program and model under <home>/speech, checks every byte
// against the catalog before anything runs, and keeps going whichever device is watching. Nothing
// here starts on its own, and it never touches a Whisper the person installed themselves.
export class SpeechInstaller {
  readonly ready: Promise<void>;
  #installed: Installed | null = null;
  // The installed files passed their hashes in this run, with the size and time of each.
  #verified: { path: string; size: number; mtimeMs: number }[] | null = null;
  #damaged = false;
  #job: SpeechInstallJob | null = null;
  #abort: AbortController | null = null;
  #running: Promise<void> | null = null;

  constructor(private readonly options: SpeechInstallerOptions) {
    this.ready = this.#recover();
  }

  get #root() {
    return join(this.options.home, "speech");
  }
  get #partials() {
    return join(this.#root, "partial");
  }
  get #target() {
    return catalogTarget(this.options.catalog, this.options.host);
  }

  async #recover() {
    this.#installed = this.#readRecord("installed.json", Installed);
    if (this.#installed) await this.#verifyInstalled();
    const under = this.#readRecord("installing.json", Under);
    if (under) {
      const totals = this.#totals(under.tier);
      this.#job = {
        tier: under.tier,
        state: "failed",
        stage: under.stage,
        doneBytes: Math.min(await this.#partialBytes(), totals),
        totalBytes: totals,
        problem: "interrupted",
        message:
          "localDot restarted during the download. What came through is kept: Retry to continue.",
      };
    }
  }

  #readRecord<T>(name: string, schema: { parse(value: unknown): T }): T | null {
    try {
      return schema.parse(JSON.parse(readFileSync(join(this.#root, name), "utf8")));
    } catch {
      return null;
    }
  }

  async #writeRecord(name: string, value: unknown) {
    const temp = join(this.#root, `.${name}.${randomBytes(4).toString("hex")}`);
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, join(this.#root, name));
  }

  async #partialBytes() {
    try {
      let total = 0;
      for (const name of await readdir(this.#partials))
        total += (await stat(join(this.#partials, name))).size;
      return total;
    } catch {
      return 0;
    }
  }

  #filesOf(record: Installed) {
    const engine = join(this.#root, "engine", record.engineVersion);
    const model = join(this.#root, "models", record.tier);
    return [
      ...Object.entries(record.engineFiles).map(([path, pin]) => ({
        path: join(engine, path),
        pin,
      })),
      ...Object.entries(record.modelFiles).map(([path, pin]) => ({ path: join(model, path), pin })),
    ];
  }

  async #verifyInstalled() {
    const record = this.#installed;
    if (!record) return;
    const seen: { path: string; size: number; mtimeMs: number }[] = [];
    for (const { path, pin } of this.#filesOf(record)) {
      try {
        const found = await stat(path);
        if (!found.isFile() || found.size !== pin.bytes || (await sha256Of(path)) !== pin.sha256) {
          this.#damaged = true;
          this.#verified = null;
          return;
        }
        seen.push({ path, size: found.size, mtimeMs: found.mtimeMs });
      } catch {
        this.#damaged = true;
        this.#verified = null;
        return;
      }
    }
    this.#damaged = false;
    this.#verified = seen;
  }

  // The hashes were checked at start-up and after installing. A file touched since isn't run.
  #stillVerified() {
    if (!this.#verified) return false;
    for (const { path, size, mtimeMs } of this.#verified) {
      try {
        const found = statSync(path);
        if (found.size === size && found.mtimeMs === mtimeMs) continue;
      } catch {
        // Gone counts as changed.
      }
      this.#verified = null;
      this.#damaged = true;
      return false;
    }
    return true;
  }

  // The installed model to run, only once its files have matched their hashes.
  model(): InstalledSpeechModel | null {
    const record = this.#installed;
    if (!record || !this.#stillVerified()) return null;
    return {
      binary: join(this.#root, "engine", record.engineVersion, record.binary),
      args: this.#runArgs(record, join(this.#root, "models", record.tier)),
      languages: record.languages,
    };
  }

  #runArgs(record: Pick<Installed, "flags" | "args">, dir: string) {
    return [
      ...Object.entries(record.flags).map(([flag, file]) => `--${flag}=${join(dir, file)}`),
      ...record.args,
      `--num-threads=${speechThreads(this.options.host)}`,
    ];
  }

  #totals(tier: TierId) {
    const spec = this.options.catalog.tiers.find((one) => one.id === tier);
    const engine = this.#target;
    return (
      (spec ? bundleDownload(spec) : 0) +
      (engine && this.#installed?.engineVersion !== this.options.catalog.engine.version
        ? bundleDownload(engine)
        : 0)
    );
  }

  status(): SpeechInstallStatus {
    const { catalog, host, handInstalled, handInstalledChosen } = this.options;
    const engine = this.#target;
    const engineHere = this.#installed?.engineVersion === catalog.engine.version;
    const installed = this.#installed;
    const spec = catalog.tiers.find((tier) => tier.id === installed?.tier);
    const usable = this.model() !== null;
    const hand = handInstalled?.() ?? null;
    const fit = tierFit(host, catalog.tiers);
    return {
      supported: !!engine,
      host: {
        computer: host.platform === "darwin" ? "Mac" : "computer",
        memoryBytes: host.memoryBytes,
        cpus: host.cpus,
        arch: host.arch,
      },
      tiers: catalog.tiers.map((tier) => ({
        id: tier.id,
        name: tier.name,
        summary: tier.summary,
        credit: tier.credit,
        languages: tier.languages ? [...tier.languages] : null,
        downloadBytes: bundleDownload(tier) + (engine && !engineHere ? bundleDownload(engine) : 0),
        diskBytes: sumBytes(tier) + (engine ? sumBytes(engine) : 0),
        memoryBytes: tier.memoryBytes,
        speed: tierSpeed(host, tier),
        ...(fit.warnings[tier.id] ? { warning: fit.warnings[tier.id] } : {}),
      })),
      recommended: fit.recommended,
      installed: installed
        ? {
            tier: installed.tier,
            name: spec?.name ?? installed.tier,
            diskBytes: this.#filesOf(installed).reduce((total, file) => total + file.pin.bytes, 0),
            damaged: this.#damaged,
          }
        : null,
      handInstalled: hand,
      using:
        hand && handInstalledChosen?.()
          ? "hand-installed"
          : usable
            ? "installed"
            : hand
              ? "hand-installed"
              : null,
      job: this.#job,
      freeBytes: Math.floor((this.options.freeBytes ?? measuredFree)(this.options.home)),
    };
  }

  // Only ever from a person's press: the routes above this are owner-only.
  start(tierId: string): void {
    const parsed = SpeechTierId.safeParse(tierId);
    const tier = parsed.success
      ? this.options.catalog.tiers.find((one) => one.id === parsed.data)
      : undefined;
    if (!tier) throw new SpeechInstallRefused("That speech model isn't available.");
    if (!this.#target)
      throw new SpeechInstallRefused("There's no speech program for this system yet.");
    if (this.#job?.state === "running") {
      if (this.#job.tier === tier.id) return;
      throw new SpeechInstallRefused(`Another speech model is already downloading.`);
    }
    const engineCurrent = this.#installed?.engineVersion === this.options.catalog.engine.version;
    if (this.#installed?.tier === tier.id && engineCurrent && !this.#damaged) {
      this.#job = null;
      return;
    }
    const controller = new AbortController();
    this.#abort = controller;
    this.#job = {
      tier: tier.id,
      state: "running",
      stage: "checking",
      doneBytes: 0,
      totalBytes: this.#totals(tier.id),
    };
    this.#running = this.#install(tier, controller.signal)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const job = this.#job;
        const step =
          error instanceof InstallStep
            ? error
            : new InstallStep("unpack", "The speech model couldn't be installed. Try again.");
        console.error(`speech install stopped (${step.problem})`);
        if (job)
          this.#job = { ...job, state: "failed", problem: step.problem, message: step.message };
      })
      .finally(() => {
        if (this.#abort === controller) this.#abort = null;
        this.options.changed?.();
      });
  }

  async #install(tier: SpeechTierSpec, signal: AbortSignal) {
    const engine = this.#target;
    if (!engine) throw new InstallStep("unpack", "There's no speech program for this system yet.");
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    await this.#enter(tier.id, "checking");
    const version = this.options.catalog.engine.version;
    const engineDir = join(this.#root, "engine", version);
    const engineHere =
      this.#installed?.engineVersion === version && (await this.#bundleMatches(engineDir, engine));
    const fetchEngine = !engineHere;
    const totalBytes = bundleDownload(tier) + (fetchEngine ? bundleDownload(engine) : 0);
    await this.#checkRoom(tier, fetchEngine ? engine : null);
    this.#progress({ totalBytes });
    const staging = join(this.#root, "staging", randomBytes(6).toString("hex"));
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      let done = 0;
      const downloaded: { bundle: SpeechBundle; source: SpeechSource; file: string; to: string }[] =
        [];
      if (fetchEngine) {
        await this.#enter(tier.id, "program");
        const got = await this.#fetchBundle(engine, "speech program", signal, (now) =>
          this.#progress({ doneBytes: done + now }),
        );
        done += got.source.bytes;
        downloaded.push({ bundle: engine, ...got, to: join(staging, "engine") });
      }
      await this.#enter(tier.id, "model");
      this.#progress({ doneBytes: done });
      const model = await this.#fetchBundle(tier, "speech model", signal, (now) =>
        this.#progress({ doneBytes: done + now }),
      );
      done += model.source.bytes;
      downloaded.push({ bundle: tier, ...model, to: join(staging, "model") });

      await this.#enter(tier.id, "unpacking");
      this.#progress({ doneBytes: done });
      for (const one of downloaded) {
        signal.throwIfAborted();
        await this.#unpack(one.bundle, one.source, one.file, one.to, signal);
      }

      await this.#enter(tier.id, "testing");
      if (fetchEngine) await this.#commit(join(staging, "engine"), engineDir);
      const modelDir = join(this.#root, "models", tier.id);
      const stagedModel = join(staging, "model");
      const record: Installed = {
        tier: tier.id,
        engineVersion: version,
        binary: this.options.catalog.engine.binary,
        engineFiles: engine.files,
        modelFiles: tier.files,
        flags: tier.flags,
        args: [...tier.args],
        languages: tier.languages ? [...tier.languages] : null,
      };
      const binary = join(engineDir, record.binary);
      await chmod(binary, 0o700);
      await this.#tryOnce(binary, stagedModel, record, signal);
      signal.throwIfAborted();
      const previous = this.#installed;
      await this.#commit(stagedModel, modelDir);
      await this.#writeRecord("installed.json", record);
      await writeFile(join(this.#root, "NOTICES.txt"), `${tier.credit}\n\n${SPEECH_NOTICES}\n`, {
        mode: 0o600,
      });
      this.#installed = record;
      await this.#verifyInstalled();
      if (previous && previous.tier !== tier.id)
        await rm(join(this.#root, "models", previous.tier), { recursive: true, force: true });
      if (previous && previous.engineVersion !== version)
        await rm(join(this.#root, "engine", previous.engineVersion), {
          recursive: true,
          force: true,
        });
      await rm(this.#partials, { recursive: true, force: true });
      await mkdir(this.#partials, { recursive: true, mode: 0o700 });
      await rm(join(this.#root, "installing.json"), { force: true });
      this.#job = null;
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  // Kept on disk too, so a restart can say where it had got to.
  async #enter(tier: TierId, stage: SpeechInstallStage) {
    this.#progress({ stage });
    await this.#writeRecord("installing.json", { tier, stage });
  }

  #progress(patch: Partial<SpeechInstallJob>) {
    if (this.#job?.state === "running") this.#job = { ...this.#job, ...patch };
  }

  async #bundleMatches(dir: string, bundle: SpeechBundle) {
    for (const [path, pin] of Object.entries(bundle.files)) {
      if (!(await this.#fileMatches(join(dir, path), pin))) return false;
    }
    return true;
  }

  async #fileMatches(path: string, pin: SpeechFilePin) {
    try {
      const found = await stat(path);
      return found.isFile() && found.size === pin.bytes && (await sha256Of(path)) === pin.sha256;
    } catch {
      return false;
    }
  }

  async #checkRoom(tier: SpeechTierSpec, engine: SpeechBundle | null) {
    let have = await this.#partialBytes();
    const download = bundleDownload(tier) + (engine ? bundleDownload(engine) : 0);
    const unpacked = sumBytes(tier) + (engine ? sumBytes(engine) : 0);
    have = Math.min(have, download);
    // An archive and what it unpacks to sit side by side until the archive is dropped.
    const needed = download - have + unpacked;
    const free = (this.options.freeBytes ?? measuredFree)(this.#root);
    if (free < needed)
      throw new InstallStep(
        "disk",
        `This needs ${sizeWords(needed)} free on this computer, and ${sizeWords(free)} is free. Free some up, then Retry.`,
      );
  }

  // Tries each source in turn. Every source is pinned, so any of them is as good as another.
  async #fetchBundle(
    bundle: SpeechBundle,
    what: string,
    signal: AbortSignal,
    report: (done: number) => void,
  ) {
    let failure: unknown;
    for (const source of bundle.sources) {
      signal.throwIfAborted();
      const file = join(this.#partials, `${source.sha256.slice(0, 16)}.ok`);
      if (existsSync(file) && (await sha256Of(file)) === source.sha256) {
        report(source.bytes);
        return { source, file };
      }
      try {
        await downloadVerified({
          url: source.url,
          bytes: source.bytes,
          sha256: source.sha256,
          to: file,
          partials: this.#partials,
          signal,
          report,
          fetch: this.options.fetch,
          freeBytes: this.options.freeBytes,
          waitMs: this.options.waitMs,
          attempts: this.options.attempts,
          stallMs: this.options.stallMs,
        });
        return { source, file };
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof SpeechDownloadProblem && error.problem === "disk")
          throw new InstallStep("disk", downloadWords("disk", what));
        failure = error;
      }
    }
    const problem = failure instanceof SpeechDownloadProblem ? failure.problem : "network";
    throw new InstallStep(problem, downloadWords(problem, what));
  }

  async #unpack(
    bundle: SpeechBundle,
    source: SpeechSource,
    file: string,
    to: string,
    signal: AbortSignal,
  ) {
    await mkdir(to, { recursive: true, mode: 0o700 });
    const members = Object.keys(bundle.files);
    if (source.root) await extractTar(file, to, source.root, members, signal);
    else {
      const [only] = members;
      if (!only) throw new InstallStep("unpack", "The download is empty.");
      await mkdir(join(to, only, ".."), { recursive: true, mode: 0o700 });
      await rename(file, join(to, only));
    }
    for (const [path, pin] of Object.entries(bundle.files))
      if (!(await this.#fileMatches(join(to, path), pin)))
        throw new InstallStep(
          "verify",
          "The download didn't match its checksum, so nothing was run. Retry, and tell us if it happens again.",
        );
  }

  async #commit(from: string, to: string) {
    await mkdir(join(to, ".."), { recursive: true, mode: 0o700 });
    await rm(to, { recursive: true, force: true });
    await rename(from, to);
  }

  async #tryOnce(binary: string, modelDir: string, record: Installed, signal: AbortSignal) {
    const wav = join(modelDir, ".silence.wav");
    await writeFile(wav, silentWav(), { mode: 0o600 });
    try {
      const out = await (this.options.run ?? hostRun)(
        binary,
        [...this.#runArgs(record, modelDir), wav],
        signal,
      );
      if (!out.includes('"text"')) throw new Error("no words line");
    } catch (error) {
      signal.throwIfAborted();
      console.error(`speech program failed to start (${basename(binary)})`, codeOf(error));
      throw new InstallStep(
        "cannot-run",
        "The speech program couldn't start on this computer. Your files are fine, and nothing changed. Tell us your system version if this keeps happening.",
      );
    } finally {
      await rm(wav, { force: true });
    }
  }

  async cancel(): Promise<void> {
    const job = this.#job;
    if (!job) return;
    this.#abort?.abort(new Error("cancelled"));
    await this.#running?.catch(() => {});
    this.#job = null;
    await rm(this.#partials, { recursive: true, force: true }).catch(() => {});
    if (existsSync(this.#root)) {
      mkdirSync(this.#partials, { recursive: true, mode: 0o700 });
      await rm(join(this.#root, "installing.json"), { force: true }).catch(() => {});
      await rm(join(this.#root, "staging"), { recursive: true, force: true }).catch(() => {});
    }
    // Nothing else installed: a cancel leaves no program behind either.
    if (!this.#installed) await rm(join(this.#root, "engine"), { recursive: true, force: true });
    this.options.changed?.();
  }

  async remove(): Promise<void> {
    if (this.#job?.state === "running")
      throw new SpeechInstallRefused("Cancel the download before removing speech.");
    this.#job = null;
    this.#installed = null;
    this.#verified = null;
    this.#damaged = false;
    await rm(this.#root, { recursive: true, force: true });
    this.options.changed?.();
  }

  async close(): Promise<void> {
    this.#abort?.abort(new Error("closing"));
    await this.#running?.catch(() => {});
  }
}

function codeOf(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
}
