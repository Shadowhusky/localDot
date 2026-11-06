import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type {
  BrowserEngineRequest,
  BrowserEngineStatus,
} from "../../../../packages/protocol/src/browser-engine.ts";
import type { AccountsProfile } from "./accounts-profile.ts";
import {
  type BrowserIdentity,
  browserIdentity,
  CHROME_INSTALL_LABEL,
  ChromeImage,
  ChromeInstallError,
  compareVersions,
  inspectImage,
  installChromeImage,
  latestChromeVersion,
  majorOf,
  removeChromeImages,
  removeImage,
  verifyChromeImage,
} from "./chrome-image.ts";
import { type DockerClient, DockerError } from "./docker.ts";

type Docker = Pick<DockerClient, "request">;

// How long a browser start waits for an install under way before it opens Chromium instead.
const INSTALL_WAIT_MS = 120_000;
const INSTALL_RETRY_MS = 10 * 60_000;
const UPDATE_CHECK_MS = 24 * 60 * 60_000;
const UPDATE_FIRST_CHECK_MS = 60_000;
const UPDATE_FETCH_MS = 30_000;

const RECORD_FILE = "browser-engine.json";
const EngineRecord = z.strictObject({
  v: z.literal(1),
  choice: z.enum(["chrome", "chromium"]),
  acceptedAt: z.iso.datetime().optional(),
  chrome: ChromeImage.optional(),
  // Chrome opens the saved sign-ins only once they are backed up. "done" is one-way for the profile.
  handOver: z.enum(["pending", "done", "failed"]).optional(),
  backup: z.strictObject({ at: z.iso.datetime(), version: z.string().optional() }).optional(),
  problem: z.strictObject({ text: z.string().max(400), at: z.iso.datetime() }).optional(),
});
type EngineRecord = z.infer<typeof EngineRecord>;

// A choice the user has to change something before making; the message says what.
export class BrowserEngineRefusal extends Error {}

export interface BrowserEngineDeps {
  home: string;
  docker: Docker;
  prefix: string;
  seccomp: string;
  // The browser image this release pins, which stays untouched whichever browser is in use.
  base(): string;
  accounts: Pick<
    AccountsProfile,
    "lastVersion" | "backup" | "hasBackup" | "dropBackup" | "restoreBackup"
  >;
  // Restarts the web browsers running now, so they open what was just chosen.
  restart(reason: string): void;
  report?(message: string): void;
  fetchText?(url: string, signal: AbortSignal): Promise<string>;
  repository?: string;
}

const fetchText = async (url: string, signal: AbortSignal) => {
  const reply = await fetch(url, { signal });
  if (!reply.ok) throw new Error(`${reply.status}`);
  return reply.text();
};

function installProblem(error: unknown): string {
  if (error instanceof ChromeInstallError) return error.message;
  if (error instanceof DockerError)
    return error.timedOut ? "Docker didn't answer in time" : "Docker refused part of the install";
  return "Chrome's install didn't finish";
}

export function readBrowserEngine(home: string): EngineRecord | undefined {
  let text: string;
  try {
    text = readFileSync(join(home, RECORD_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return EngineRecord.parse(JSON.parse(text));
  } catch {
    // A damaged record keeps the pinned image: Chrome is only ever a choice someone made.
    return undefined;
  }
}

export const browserEngineOwner = (home: string) =>
  createHash("sha256").update(realpathSync(home)).digest("hex").slice(0, 12);

// Which browser the web browser runs, and the one-way hand-over of the saved sign-ins to Chrome.
// With no record the user hasn't chosen, and nothing changes: Chromium from the pinned image.
export class BrowserEngine {
  readonly #path: string;
  readonly #owner: string;
  #installing: Promise<void> | undefined;
  #installFailedAt = 0;
  #restartWhenReady = false;
  #updates: AbortController | undefined;
  readonly #identities = new Map<string, BrowserIdentity | undefined>();

  constructor(private readonly deps: BrowserEngineDeps) {
    this.#path = join(deps.home, RECORD_FILE);
    this.#owner = browserEngineOwner(deps.home);
  }

  #read(): EngineRecord | undefined {
    return readBrowserEngine(this.deps.home);
  }

  #write(value: EngineRecord): void {
    const temp = `${this.#path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(EngineRecord.parse(value))}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temp, this.#path);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  #note(record: EngineRecord, text: string): EngineRecord {
    const noted = {
      ...record,
      problem: { text: text.slice(0, 400), at: new Date().toISOString() },
    };
    this.#write(noted);
    return noted;
  }

  // Nothing to wait for or read from Docker: the path of everyone who hasn't chosen Chrome.
  get pinned(): boolean {
    return this.#read()?.choice !== "chrome";
  }

  async #valid(record: EngineRecord | undefined): Promise<boolean> {
    if (!record?.chrome) return false;
    return verifyChromeImage(this.deps.docker, record.chrome, this.deps.base()).catch(() => false);
  }

  #install(): Promise<void> {
    this.#installing ??= this.#runInstall().finally(() => {
      this.#installing = undefined;
    });
    return this.#installing;
  }

  async #runInstall(): Promise<void> {
    const before = this.#read();
    if (before?.choice !== "chrome") return;
    try {
      const chrome = await installChromeImage(this.deps.docker, {
        base: this.deps.base(),
        owner: this.#owner,
        prefix: this.deps.prefix,
        seccomp: this.deps.seccomp,
        ...(this.deps.repository ? { repository: this.deps.repository } : {}),
      });
      const record = this.#read();
      if (record?.choice !== "chrome") {
        await removeImage(this.deps.docker, chrome.image);
        return;
      }
      const { problem: _, ...rest } = record;
      this.#write({
        ...rest,
        chrome,
        handOver: record.handOver === "done" ? "done" : "pending",
      });
      this.#installFailedAt = 0;
      await removeChromeImages(this.deps.docker, this.#owner, chrome.image).catch(() => {});
      if (this.#restartWhenReady) {
        this.#restartWhenReady = false;
        this.deps.restart("Switching to Google Chrome.");
      }
    } catch (error) {
      this.#installFailedAt = Date.now();
      this.#restartWhenReady = false;
      const record = this.#read();
      if (record?.choice === "chrome") this.#note(record, installProblem(error));
      this.deps.report?.(`Chrome's install failed: ${(error as Error).message}`);
    }
  }

  // Waits, within reason, for Chrome to be there for a browser about to start. An install that
  // failed isn't tried again on every start of a browser that is already falling back.
  async settled(signal: AbortSignal): Promise<void> {
    const record = this.#read();
    if (record?.choice !== "chrome") return;
    if (
      !this.#installing &&
      !(await this.#valid(record)) &&
      Date.now() - this.#installFailedAt > INSTALL_RETRY_MS
    )
      void this.#install();
    if (!this.#installing) return;
    const done = new AbortController();
    try {
      await Promise.race([
        this.#installing,
        delay(INSTALL_WAIT_MS, undefined, {
          signal: AbortSignal.any([signal, done.signal]),
          ref: false,
        }),
      ]);
    } finally {
      done.abort();
    }
  }

  async handOverPending(): Promise<boolean> {
    const record = this.#read();
    return (
      record?.choice === "chrome" && record.handOver === "pending" && (await this.#valid(record))
    );
  }

  // Backs up the sign-ins, then lets Chrome open them. A profile no browser has opened needs no
  // copy. It runs with no browser holding the profile, and failing leaves Chromium in use.
  async handOver(): Promise<void> {
    const record = this.#read();
    if (record?.choice !== "chrome" || !record.chrome) return;
    try {
      const version = await this.deps.accounts.lastVersion();
      if (version && majorOf(version) > majorOf(record.chrome.version))
        throw new BrowserEngineRefusal(
          `Your sign-ins were last used by a newer browser (${version}) than Chrome ${record.chrome.version}, so they stay in Chromium until Chrome updates.`,
        );
      if (version) await this.deps.accounts.backup();
      const { problem: _, ...rest } = record;
      this.#write({
        ...rest,
        handOver: "done",
        ...(version
          ? { backup: { at: new Date().toISOString(), version } }
          : { backup: undefined }),
      });
    } catch (error) {
      this.#note(
        { ...record, handOver: "failed" },
        error instanceof BrowserEngineRefusal
          ? error.message
          : `Your sign-ins couldn't be backed up, so Chromium stays in use: ${
              error instanceof DockerError || !(error instanceof Error)
                ? "Docker didn't finish the copy"
                : error.message
            }.`,
      );
    }
  }

  // The image the next browser start uses: Chrome's only when it was chosen, its sign-ins were
  // handed over, and it is still exactly the pinned image with Chrome's one layer on top.
  async image(): Promise<string> {
    const record = this.#read();
    if (record?.choice === "chrome" && record.handOver === "done" && record.chrome) {
      if (await this.#valid(record)) return record.chrome.image;
      if (!record.problem)
        this.#note(record, "Chrome needs installing again for this version of localDot.");
    }
    return this.deps.base();
  }

  // Records the choice and starts whatever it asks for. Declining or going back never waits.
  async choose(request: BrowserEngineRequest): Promise<void> {
    const current = this.#read();
    if (request.choice === "chrome") {
      const { problem: _, ...rest } = current ?? { v: 1 as const };
      const record: EngineRecord = {
        ...rest,
        v: 1,
        choice: "chrome",
        acceptedAt: new Date().toISOString(),
        handOver: current?.handOver === "done" ? "done" : "pending",
      };
      this.#write(record);
      this.#installFailedAt = 0;
      if (await this.#valid(record)) {
        if (request.restart) this.deps.restart("Switching to Google Chrome.");
        return;
      }
      this.#restartWhenReady = request.restart === true;
      void this.#install();
      return;
    }
    if (current?.choice === "chrome" && current.handOver === "done") await this.#refuseOlder();
    const backup = current?.backup;
    this.#write({ v: 1, choice: "chromium", ...(backup ? { backup } : {}) });
    this.#restartWhenReady = false;
    await removeChromeImages(this.deps.docker, this.#owner).catch(() => {});
    if (current?.choice === "chrome" && current.handOver === "done")
      this.deps.restart("Switching to Chromium.");
  }

  async #refuseOlder(): Promise<void> {
    const base = await inspectImage(this.deps.docker, this.deps.base());
    const chromium = base && (await this.#identity(base.Id));
    const version = await this.deps.accounts.lastVersion();
    if (version && (!chromium?.version || majorOf(version) > majorOf(chromium.version)))
      throw new BrowserEngineRefusal(
        (await this.deps.accounts.hasBackup())
          ? "Chrome has updated your sign-ins, so Chromium can't open them. Go back to the backup instead."
          : "Chrome has updated your sign-ins, so Chromium can't open them. Sign out of all sites first.",
      );
  }

  // With every browser stopped: the sign-ins as they were before Chrome, and Chromium again.
  async restore(): Promise<void> {
    await this.deps.accounts.restoreBackup();
    await this.deps.accounts.dropBackup();
    this.#write({ v: 1, choice: "chromium" });
    this.#restartWhenReady = false;
    await removeChromeImages(this.deps.docker, this.#owner).catch(() => {});
  }

  async dropBackup(): Promise<void> {
    await this.deps.accounts.dropBackup();
    const record = this.#read();
    if (record?.backup) {
      const { backup: _, ...rest } = record;
      this.#write(rest);
    }
  }

  // Signing out of everything took the backup with the profile.
  signedOut(): void {
    const record = this.#read();
    if (record?.backup) {
      const { backup: _, ...rest } = record;
      this.#write(rest);
    }
  }

  async #identity(imageId: string): Promise<BrowserIdentity | undefined> {
    if (!this.#identities.has(imageId)) {
      const identity = await browserIdentity(this.deps.docker, imageId, this.deps.prefix).catch(
        () => undefined,
      );
      if (!identity) return undefined;
      this.#identities.set(imageId, identity);
    }
    return this.#identities.get(imageId);
  }

  async status(restartNeeded = false): Promise<BrowserEngineStatus> {
    const record = this.#read();
    const base = await inspectImage(this.deps.docker, this.deps.base()).catch(() => undefined);
    const identity = base && (await this.#identity(base.Id));
    const builtIn = identity?.engine === "chrome";
    const valid = await this.#valid(record);
    const chosen = record?.choice === "chrome" && valid;
    const usingChrome = !builtIn && chosen && record.handOver === "done";
    const backup = record?.backup && (await this.deps.accounts.hasBackup().catch(() => false));
    const version = usingChrome ? record?.chrome?.version : identity?.version;
    return {
      engine: builtIn || usingChrome ? "chrome" : "chromium",
      ...(version ? { version } : {}),
      choice: record?.choice ?? null,
      offered: !builtIn && base?.Config?.Labels?.[CHROME_INSTALL_LABEL] === "1",
      builtIn,
      installing: this.#installing !== undefined,
      restartNeeded: restartNeeded || (chosen && record.handOver === "pending"),
      ...(record?.problem ? { problem: record.problem.text, problemAt: record.problem.at } : {}),
      ...(backup && record?.backup ? { backup: record.backup } : {}),
    };
  }

  // Keeps Chrome up to date in the background: a new image for the next browser start, from the
  // same pinned base, the running browser untouched. Linux Chrome has no updater of its own.
  watch(): () => void {
    const updates = new AbortController();
    this.#updates?.abort();
    this.#updates = updates;
    void (async () => {
      const { signal } = updates;
      try {
        await delay(UPDATE_FIRST_CHECK_MS, undefined, { signal, ref: false });
        for (;;) {
          await this.checkForUpdate(signal).catch(() => {});
          await delay(UPDATE_CHECK_MS, undefined, { signal, ref: false });
        }
      } catch {
        /* Stopped with the daemon. */
      }
    })();
    return () => updates.abort();
  }

  async checkForUpdate(signal: AbortSignal): Promise<void> {
    const record = this.#read();
    if (record?.choice !== "chrome" || this.#installing) return;
    if (!(await this.#valid(record))) {
      if (Date.now() - this.#installFailedAt > INSTALL_RETRY_MS) void this.#install();
      return;
    }
    const image = record.chrome && (await inspectImage(this.deps.docker, record.chrome.image));
    if (!image?.Architecture || !record.chrome) return;
    await removeChromeImages(this.deps.docker, this.#owner, record.chrome.image).catch(() => {});
    const latest = await latestChromeVersion(image.Architecture, (url) =>
      (this.deps.fetchText ?? fetchText)(
        url,
        AbortSignal.any([signal, AbortSignal.timeout(UPDATE_FETCH_MS)]),
      ),
    );
    if (latest && compareVersions(latest, record.chrome.version) > 0) void this.#install();
  }
}
