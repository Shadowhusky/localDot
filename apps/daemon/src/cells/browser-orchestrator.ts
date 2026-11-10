import { randomUUID } from "node:crypto";
import { type ComputerSize, DEFAULT_COMPUTER_SIZE, ULID_PATTERN, ulid } from "@localdot/protocol";
import {
  type BrowserStatus,
  BrowserSupervisorState,
} from "../../../../packages/protocol/src/browser-control.ts";
import type {
  BrowserEngineRequest,
  BrowserEngineStatus,
} from "../../../../packages/protocol/src/browser-engine.ts";
import type { ComputerResetSource } from "../../../../packages/protocol/src/computer-reset.ts";
import {
  type BrowserKeydClient,
  closeBrowserKeyd,
  openBrowserKeyd,
} from "../keyd/browser-wiring.ts";
import { KeydError } from "../keyd/client.ts";
import { AccountsProfile } from "./accounts-profile.ts";
import { BrowserEngine } from "./browser-engine.ts";
import {
  answersReady,
  describeBrowserFailure,
  readBrowserHealth,
  readBrowserSupervisor,
  validateBrowserHealth,
} from "./browser-health.ts";
import {
  type BrowserLedger,
  BrowserLedgerStore,
  BrowserLifecycleError,
  BrowserStartCancelled,
  browserKey,
} from "./browser-ledger.ts";
import {
  browserLabels,
  browserObjectPath,
  inspectBrowserResources,
  requireDetachedProfile,
  requireFreshBrowserNames,
  retireBrowserResources,
} from "./browser-resources.ts";
import { BROWSER_SECCOMP, browserNames, browserNetworkSpec, browserSpec } from "./browser-spec.ts";
import { browserLimits } from "./computer-size.ts";
import { type DockerClient, DockerError, dockerLogLines } from "./docker.ts";
import type { BrowserImages } from "./images.ts";
import { hostAddress } from "./ipv4.ts";
import { allocateKeydPort } from "./ports.ts";
import { ProfileSlots, SlotPauseStuck } from "./profile-slots.ts";
import { type GateRelay, HOST_RELAY } from "./relay.ts";
import { captureComputerResetSource } from "./reset-source.ts";
import { newCellToken } from "./secrets.ts";
import {
  DESKTOP_OFFSET,
  GATE_OFFSET,
  GATE_PORTS,
  gateSpec,
  ISOLATED_GATEWAY_OPTION,
  NAME_PREFIX,
} from "./spec.ts";
import { sendContainerInput } from "./stdin.ts";
import type { CellStore } from "./store.ts";
import type { BrowserCellRecord, CellState } from "./types.ts";

type Docker = Pick<DockerClient, "request" | "socketPath">;
const HEALTH_TIMEOUT_MS = 3000;
// As long as a computer gets to become ready: under load Chromium can take minutes to come up, and a
// start that times out is begun again from nothing.
const READY_TIMEOUT_MS = 180_000;

// Why a browser can't run now, for the app, the CLI and dot.
export type BrowserBlock = Required<Pick<BrowserStatus, "reason" | "problem" | "clears">> &
  Pick<BrowserStatus, "retryAt">;

const COMPUTER_STOPPED: BrowserBlock = {
  reason: "computer-stopped",
  problem: "The computer is not running.",
  clears: "Start the computer; the web browser starts with it.",
};
const KEYS_LOCKED = {
  reason: "keys-locked",
  problem:
    "Saved keys are locked. The web browser works and keeps its sign-ins, but saved passwords and sites that use a saved key are refused until they are unlocked.",
  clears: "Unlock saved keys in localDot (Keys).",
} as const;
// What dot hears when its web browser runs again after it could not have it.
export const BROWSER_BACK =
  "localDot: the web browser is running again (its saved sign-ins are kept; pages that were open are closed). If you were waiting for it, go on: open the page again with browser_navigate.";
type Raw = Record<string, unknown>;
const raw = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const dockerId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new BrowserLifecycleError();
  return value;
};

export interface ReadyBrowser {
  browserCellId: string;
  parentCellId: string;
  // A conversation's own browser; absent for the computer's main one.
  slot?: string;
  instance: string;
  browserd: { baseUrl: string; token: string };
  stream: { baseUrl: string; authorization: string };
}

export interface BrowserOrchestratorDeps {
  home: string;
  store: CellStore;
  docker: Docker;
  keyd: BrowserKeydClient;
  images: BrowserImages;
  // Where a local Chrome image is tagged; only tests choose another.
  chromeRepository?: string;
  // How gates reach keyd and the daemon (cells/relay.ts); Docker Desktop's host name by default.
  relay?: () => Promise<GateRelay>;
  streamFullcolor?: boolean;
  parentAvailable(parentCellId: string): boolean;
  externalKeydPorts?(): Iterable<number>;
  // Consult the desktop owner's verified retirement, never infer it from an idle/off state.
  retiredDesktopPortOwner?(id: string): boolean;
  namePrefix?: string;
  readyTimeoutMs?: number;
  probe?: typeof readBrowserHealth;
  supervisor?: typeof readBrowserSupervisor;
  sendInput?: typeof sendContainerInput;
  // Why a computer's browser cannot run now, when it cannot: its computer is off, or keyd is.
  unavailable?(parentCellId: string): BrowserBlock | undefined;
  // keyd's saved-keys vault waits for its passphrase.
  keysLocked?(): boolean;
  // A word to the tasks using this browser: its computer's id for the main one, else its slot.
  notify?(key: string, text: string): void;
  // The dot's computer size, which each new web browser takes its share of.
  size?(): ComputerSize;
}

// browserd's own lines in the container log: the reasons it stopped, never page data.
const BROWSERD_LOG = /^browserd: [^\n]{1,300}$/u;

// What made a start fail, in fixed words: no paths, ids or replies.
function startCause(error: unknown): string | undefined {
  if (error instanceof BrowserLifecycleError)
    return error.message === new BrowserLifecycleError().message ? undefined : error.message;
  if (error instanceof KeydError)
    return error.status
      ? `the key service refused it (${error.status} ${error.code})`
      : "the key service didn't answer";
  if (error instanceof DockerError)
    return error.timedOut
      ? "Docker didn't answer in time"
      : error.status
        ? `Docker refused it (${error.status})`
        : "Docker didn't answer";
  return undefined;
}

export class BrowserOrchestrator {
  readonly #ledger: BrowserLedgerStore;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #epochs = new Map<string, number>();
  readonly #starting = new Map<string, AbortController>();
  readonly #ready = new Map<string, ReadyBrowser>();
  readonly #state = new Map<string, CellState>();
  // A Replace computer waiting for the saved sign-ins; any later fence of its computer cancels it.
  readonly #resets = new Map<string, AbortController>();
  readonly #listeners = new Set<(parentCellId: string) => void>();
  // Why each computer's browser last failed or was restarted, for status and the agent.
  readonly #problems = new Map<string, { text: string; at: string }>();
  // When a failed browser is started again by itself; no time once that has been given up.
  readonly #retries = new Map<string, { at?: string }>();
  // Computers whose browser someone could not have since it last ran: told when it runs again.
  readonly #outages = new Set<string>();
  readonly #startedAt = new Map<string, number>();
  readonly #accounts: AccountsProfile;
  readonly #slots: ProfileSlots;
  // Each conversation browser's computer, from when it is opened until its record says so.
  readonly #parents = new Map<string, string>();
  readonly #engine: BrowserEngine;
  // The image each running browser was created from, to tell when one is behind.
  readonly #images = new Map<string, string>();
  #attaching: Promise<void> = Promise.resolve();

  subscribe(listener: (parentCellId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Listeners hear the computer whose browsers changed.
  #changed(key: string): void {
    const parentCellId = this.#parentOf(key) ?? key;
    for (const listener of this.#listeners) {
      try {
        listener(parentCellId);
      } catch {
        /* Observers cannot delay containment. */
      }
    }
  }

  constructor(private readonly deps: BrowserOrchestratorDeps) {
    this.#ledger = new BrowserLedgerStore(deps.home, deps.store.keydPorts);
    this.#accounts = new AccountsProfile({
      home: deps.home,
      docker: deps.docker,
      prefix: deps.namePrefix ?? NAME_PREFIX,
      image: () => deps.images.browser,
    });
    this.#slots = new ProfileSlots({
      docker: deps.docker,
      image: () => deps.images.browser,
      report: (message) => console.error(message),
    });
    this.#engine = new BrowserEngine({
      home: deps.home,
      docker: deps.docker,
      prefix: deps.namePrefix ?? NAME_PREFIX,
      seccomp: BROWSER_SECCOMP,
      base: () => deps.images.browser,
      accounts: this.#accounts,
      restart: (reason) => this.#restartRunning(reason),
      report: (message) => console.error(message),
      ...(deps.chromeRepository ? { repository: deps.chromeRepository } : {}),
    });
  }

  async engineStatus(): Promise<BrowserEngineStatus> {
    const image = await this.#engine.image();
    return this.#engine.status(
      [...this.#ready.keys()].some((parent) => {
        const running = this.#images.get(parent);
        return running !== undefined && running !== image;
      }),
    );
  }

  chooseEngine(request: BrowserEngineRequest): Promise<void> {
    return this.#engine.choose(request);
  }

  // Back to Chromium and the sign-ins as they were before Chrome: every browser lets go of the
  // profile first, and the warmer starts them again. Conversations' slots copied from a profile
  // Chrome opened can't go back, so they go.
  restoreEngineBackup(): Promise<void> {
    const keys = this.#ledger.list().map(browserKey);
    return this.#exclusive(new AbortController().signal, async () => {
      await Promise.all(keys.map((key) => this.#stop(key, false)));
      await this.#dropSlots();
      await this.#engine.restore();
    });
  }

  dropEngineBackup(): Promise<void> {
    return this.#engine.dropBackup();
  }

  // Keeps Chrome up to date while the daemon runs.
  watchEngine(): () => void {
    return this.#engine.watch();
  }

  #restartRunning(reason: string): void {
    for (const parent of this.#ready.keys()) void this.restart(parent, reason).catch(() => {});
  }

  // The computer whose browser has the saved sign-ins open, is opening them, or still has a
  // container that may hold them. Conversations' browsers have slots of their own.
  profileHolder(): string | undefined {
    const [active] = [...this.#ready.keys(), ...this.#starting.keys()].filter((key) =>
      this.#isMain(key),
    );
    if (active) return active;
    try {
      return this.#ledger.list().find((record) => !record.slot && record.resources.browser)
        ?.parentCellId;
    } catch {
      return undefined;
    }
  }

  // Signs out of every site: each browser lets go of the profile, which is then made again empty,
  // and the profiles computers kept for themselves before sign-ins were shared are deleted, and so
  // are conversations' own.
  clearAccounts(): Promise<void> {
    const keys = this.#ledger.list().map(browserKey);
    return this.#exclusive(new AbortController().signal, async () => {
      await Promise.all(keys.map((key) => this.#stop(key, true)));
      await this.#dropSlots();
      await this.#accounts.wipe();
      this.#engine.signedOut();
    });
  }

  async #dropSlots(): Promise<void> {
    const slots = this.#ledger.list().filter((record) => record.slot);
    const results = await Promise.allSettled(
      slots.map((record) => this.remove(browserKey(record), { purgeProfile: true })),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new BrowserLifecycleError("A conversation's browser could not be removed");
  }

  // Makes a conversation's own browser known before its first start; its record keeps it after.
  openSlot(parentCellId: string, slot: string): void {
    if (!ULID_PATTERN.test(parentCellId) || !ULID_PATTERN.test(slot) || slot === parentCellId)
      throw new BrowserLifecycleError();
    const known = this.#parentOf(slot);
    if (known !== undefined && known !== parentCellId) throw new BrowserLifecycleError();
    this.#parents.set(slot, parentCellId);
  }

  // The browsers of a computer: its main one, and conversations' own.
  keysOf(parentCellId: string): string[] {
    const slots = new Set<string>();
    for (const [slot, parent] of this.#parents) if (parent === parentCellId) slots.add(slot);
    try {
      for (const record of this.#ledger.slotsOf(parentCellId)) slots.add(browserKey(record));
    } catch {}
    return [parentCellId, ...slots];
  }

  // Every conversation browser with a record, whatever its computer.
  slots(): { key: string; parentCellId: string }[] {
    try {
      return this.#ledger
        .list()
        .filter((record) => record.slot)
        .map((record) => ({ key: browserKey(record), parentCellId: record.parentCellId }));
    } catch {
      return [];
    }
  }

  // The computer a browser belongs to; the key itself for a computer's main browser.
  parentOfKey(key: string): string | undefined {
    return this.#parentOf(key);
  }

  #isMain(key: string): boolean {
    return this.#parentOf(key) === key;
  }

  #parentOf(key: string): string | undefined {
    if (!ULID_PATTERN.test(key)) return undefined;
    if (this.deps.store.get(key)) return key;
    const opened = this.#parents.get(key);
    if (opened) return opened;
    try {
      const record = this.#ledger.forKey(key);
      if (record) return record.parentCellId;
    } catch {}
    return undefined;
  }

  #parentLive(key: string): boolean {
    const parent = this.#parentOf(key);
    return !!parent && this.deps.parentAvailable(parent) && !!this.deps.store.get(parent);
  }

  // The parent a lifecycle step needs: one that can't be found is a computer gone.
  #parent(key: string): string {
    const parent = this.#parentOf(key);
    if (!parent) throw new BrowserStartCancelled();
    return parent;
  }

  reservedKeydPorts(): number[] {
    const inventory = this.deps.store.inventoryAll();
    if (inventory.skipped.length) throw new BrowserLifecycleError("Cell port ownership is unknown");
    return [
      ...new Set([
        ...inventory.records
          .filter(
            (record) =>
              record.kind !== "desktop" || !this.deps.retiredDesktopPortOwner?.(record.id),
          )
          .map((record) => record.keydPort),
        ...this.#ledger
          .list()
          .filter((record) => record.phase !== "retained")
          .map((record) => record.keydPort),
      ]),
    ];
  }

  parentOf(browserCellId: string): string | undefined {
    try {
      return this.#ledger.list().find((record) => record.id === browserCellId)?.parentCellId;
    } catch {
      return undefined;
    }
  }

  get(key: string): { id: string; parentCellId: string; state: CellState } | undefined {
    const record = this.#ledger.forKey(key);
    return record
      ? {
          id: record.id,
          parentCellId: record.parentCellId,
          state:
            this.#state.get(key) ??
            (record.phase === "stopped" || record.phase === "retained" ? "stopped" : "failed"),
        }
      : undefined;
  }

  endpoints(key: string): ReadyBrowser | undefined {
    const ready = this.#ready.get(key);
    if (
      !ready ||
      !this.deps.parentAvailable(ready.parentCellId) ||
      !this.deps.store.get(ready.parentCellId)
    )
      return undefined;
    return structuredClone(ready);
  }

  // The browsers of a computer running now.
  running(parentCellId: string): ReadyBrowser[] {
    return this.keysOf(parentCellId).flatMap((key) => this.endpoints(key) ?? []);
  }

  // How the running browser answers now: "silent" when it doesn't, "restarting" while browserd
  // starts its Chromium again in place, "unready" when it can no longer be controlled; undefined
  // when none is running.
  async health(key: string): Promise<"ready" | "restarting" | "unready" | "silent" | undefined> {
    const ready = this.#ready.get(key);
    if (!ready) return undefined;
    let value: unknown;
    try {
      value = await (this.deps.probe ?? readBrowserHealth)(
        Number(new URL(ready.browserd.baseUrl).port),
        ready.browserd.token,
        AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      );
    } catch {
      return "silent";
    }
    if (answersReady(value, ready)) return "ready";
    return (await this.supervisor(key))?.state === "restarting" ? "restarting" : "unready";
  }

  // browserd's report on its Chromium; undefined from an older image or a browser not running.
  async supervisor(key: string): Promise<BrowserSupervisorState | undefined> {
    const ready = this.#ready.get(key);
    if (!ready) return undefined;
    try {
      return BrowserSupervisorState.parse(
        await (this.deps.supervisor ?? readBrowserSupervisor)(
          Number(new URL(ready.browserd.baseUrl).port),
          ready.browserd.token,
          AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        ),
      );
    } catch {
      return undefined;
    }
  }

  // Records why the browser failed or was restarted, in words for the user and the agent.
  noteProblem(key: string, text: string): void {
    this.#problems.set(key, { text: text.slice(0, 600), at: new Date().toISOString() });
  }

  problem(key: string): string | undefined {
    return this.#problems.get(key)?.text;
  }

  // When the failed browser is started again by itself; `undefined` once that was given up.
  noteRetry(key: string, at: Date | undefined): void {
    this.#retries.set(key, at ? { at: at.toISOString() } : {});
  }

  // Someone could not have the browser; when it runs again, the task is told.
  noteOutage(key: string): void {
    this.#outages.add(key);
  }

  async status(key: string): Promise<BrowserStatus> {
    const parentCellId = this.#parentOf(key) ?? key;
    const noted = this.#problems.get(key);
    const problem = noted ? { problem: noted.text, problemAt: noted.at } : {};
    const blocked =
      this.deps.unavailable?.(parentCellId) ??
      (this.deps.parentAvailable(parentCellId) ? undefined : COMPUTER_STOPPED);
    if (blocked) return { state: "off", ...blocked };
    const locked = this.deps.keysLocked?.() ? KEYS_LOCKED : undefined;
    if (this.#ready.has(key)) {
      const supervisor = await this.supervisor(key);
      const failure = supervisor?.lastFailure;
      const restarting = supervisor?.state === "restarting";
      return {
        state: restarting ? "restarting" : "ready",
        restarts: supervisor?.restarts ?? 0,
        ...(failure && (!noted || failure.at > noted.at)
          ? { problem: `${describeBrowserFailure(failure)}.`, problemAt: failure.at }
          : problem),
        ...(locked ??
          (restarting
            ? {
                reason: "restarting" as const,
                clears: "Nothing: it restarts by itself within seconds and keeps its sign-ins.",
              }
            : {})),
      };
    }
    const state = this.get(key)?.state;
    if (state === "failed") {
      const retry = this.#retries.get(key);
      return {
        state: "failed",
        reason: "failed",
        problem: noted?.text ?? "The web browser couldn't start.",
        ...(noted ? { problemAt: noted.at } : {}),
        ...(retry?.at
          ? { retryAt: retry.at, clears: "Nothing: localDot starts it again by itself." }
          : {
              clears: retry
                ? "Restart the web browser (Settings → Accounts, or localdot browser restart); dot can restart it once with switch_screen restart."
                : "Nothing: localDot starts it again by itself.",
            }),
      };
    }
    const startedAt = this.#startedAt.get(key);
    return {
      state: state === "starting" ? "starting" : state === "stopping" ? "restarting" : "stopped",
      ...problem,
      ...(locked ?? {
        reason: state === "stopping" ? ("restarting" as const) : ("starting" as const),
        clears: "Nothing: localDot starts it by itself.",
      }),
      ...(state === "starting" && startedAt !== undefined
        ? {
            readyBy: new Date(
              startedAt + (this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS),
            ).toISOString(),
          }
        : {}),
    };
  }

  // Stops this browser and starts it again on the same profile.
  async restart(key: string, reason: string): Promise<ReadyBrowser> {
    this.noteProblem(key, reason);
    await this.stop(key);
    return this.start(key);
  }

  start(key: string, signal = new AbortController().signal): Promise<ReadyBrowser> {
    if (!ULID_PATTERN.test(key)) return Promise.reject(new BrowserLifecycleError());
    const epoch = this.#epochs.get(key) ?? 0;
    const started = this.#queued(key, () => this.#start(key, epoch, signal));
    void started.catch(() => this.#outages.add(key));
    return started;
  }

  stop(key: string): Promise<void> {
    return this.#stop(key, false);
  }

  // Every browser of a computer, as the computer stops.
  async stopComputer(parentCellId: string): Promise<void> {
    const results = await Promise.allSettled(
      this.keysOf(parentCellId).map((key) => this.stop(key)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  // Every browser of a computer, as the computer goes: conversations' slots go with it, and the
  // main browser keeps the saved sign-ins unless told otherwise.
  async removeComputer(
    parentCellId: string,
    options: { purgeProfile?: boolean } = {},
  ): Promise<void> {
    const results = await Promise.allSettled(
      this.keysOf(parentCellId).map((key) =>
        this.remove(key, key === parentCellId ? options : { purgeProfile: true }),
      ),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  #stop(key: string, purgeProfile: boolean): Promise<void> {
    this.#fence(key);
    return this.#queued(key, async () => {
      const record = this.#ledger.forKey(key);
      if (record) await this.#contain(record, purgeProfile && !record.slot);
      else if (this.#storedFor(key))
        throw new BrowserLifecycleError("Browser recovery ownership is missing");
      this.#state.set(key, "stopped");
      this.#changed(key);
    });
  }

  // A conversation's browser that goes takes its slot with it.
  remove(key: string, options: { purgeProfile?: boolean } = {}): Promise<void> {
    this.#fence(key);
    return this.#queued(key, async () => {
      const record = this.#ledger.forKey(key);
      if (!record) {
        if (this.#storedFor(key))
          throw new BrowserLifecycleError("Browser recovery ownership is missing");
        this.#parents.delete(key);
        return;
      }
      const purge = options.purgeProfile === true || record.slot !== undefined;
      await this.#contain(record, purge);
      this.#association(record);
      this.deps.store.remove(record.id);
      if (purge) {
        this.#ledger.remove(record);
        this.#parents.delete(key);
      } else {
        record.phase = "retained";
        this.#ledger.save(record);
      }
      this.#state.set(key, "removed");
      this.#changed(record.parentCellId);
    });
  }

  #storedFor(key: string): BrowserCellRecord | undefined {
    const parent = this.#parentOf(key);
    if (!parent) return undefined;
    return this.deps.store.browserFor(parent, parent === key ? undefined : key);
  }

  resetSource(parent: string): ComputerResetSource["browser"] {
    const record = this.#ledger.forParent(parent);
    if (!record) {
      if (this.deps.store.browserFor(parent))
        throw new BrowserLifecycleError("Browser reset ownership is missing");
      return null;
    }
    this.#association(record);
    const desktop = this.deps.store.get(parent);
    if (!desktop) throw new BrowserLifecycleError("Reset desktop record is missing");
    return captureComputerResetSource(desktop, record).browser;
  }

  resetRetired(parent: string, source: ComputerResetSource["browser"]): boolean {
    return (
      !this.#ledger.forParent(parent) &&
      !this.deps.store.browserFor(parent) &&
      (!source ||
        (!this.deps.store.getStored(source.id) &&
          !this.deps.store.inventoryAll().skipped.includes(source.id)))
    );
  }

  retireReset(
    parent: string,
    source: ComputerResetSource["browser"],
    retire: () => Promise<void>,
  ): Promise<void> {
    this.#fence(parent);
    const fenced = new AbortController();
    this.#resets.set(parent, fenced);
    const retired = this.#queued(parent, async () => {
      if (this.deps.parentAvailable(parent))
        throw new BrowserLifecycleError("Reset parent admission is not held");
      const slots = await Promise.allSettled(
        this.keysOf(parent)
          .filter((key) => key !== parent)
          .map((key) => this.remove(key, { purgeProfile: true })),
      );
      if (slots.some((result) => result.status === "rejected"))
        throw new BrowserLifecycleError("A conversation's browser could not be removed");
      const record = this.#ledger.forParent(parent);
      if (record) {
        if (
          !source ||
          record.id !== source.id ||
          record.owner !== source.owner ||
          browserNames(record.id, record.prefix).profileVolume !== source.resources.volume
        )
          throw new BrowserLifecycleError("Browser reset ownership changed");
        this.#association(record);
        await closeBrowserKeyd(this.deps.keyd, record);
        await this.#adoptBeforeRetire(record, fenced.signal);
      } else {
        if (
          !this.resetRetired(parent, source) ||
          (source && (await this.deps.keyd.cell(source.id)))
        )
          throw new BrowserLifecycleError("Browser reset retirement is unconfirmed");
      }
      await retire();
      if (record) {
        if ((await inspectBrowserResources(this.deps.docker, record)).length)
          throw new BrowserLifecycleError();
        await requireDetachedProfile(this.deps.docker, record);
        if (await this.deps.keyd.cell(record.id)) throw new BrowserLifecycleError();
        this.#association(record);
        this.deps.store.remove(record.id);
        this.#ledger.remove(record);
      }
      this.#state.set(parent, "removed");
    });
    return retired.finally(() => {
      if (this.#resets.get(parent) === fenced) this.#resets.delete(parent);
    });
  }

  async reconcile(): Promise<void> {
    // Recovery discovery may fail. Revoke every current or queued owner before
    // consulting disk so an unrelated damaged record cannot preserve authority.
    const current = new Set([
      ...this.#ready.keys(),
      ...this.#starting.keys(),
      ...this.#queues.keys(),
      ...this.#state.keys(),
    ]);
    // A task using a browser this stops hears when it runs again.
    for (const parent of this.#ready.keys()) this.#outages.add(parent);
    for (const parent of current) this.#fence(parent);
    const records = this.#ledger.list();
    for (const record of records) this.#fence(browserKey(record));
    const inventory = this.deps.store.inventoryAll();
    const unknown =
      inventory.skipped.length > 0 ||
      inventory.records.some(
        (record) =>
          record.kind === "browser" &&
          !records.some(
            (owner) =>
              owner.id === record.id &&
              owner.parentCellId === record.parentCellId &&
              owner.slot === record.slot,
          ),
      );
    const result = await Promise.allSettled(records.map((record) => this.stop(browserKey(record))));
    const failed = result.find((entry) => entry.status === "rejected");
    if (unknown || failed)
      throw new BrowserLifecycleError(
        `Browser recovery needs attention (${
          unknown
            ? "a browser record is unreadable or has no owner"
            : failed?.reason instanceof BrowserLifecycleError
              ? failed.reason.message
              : "a browser could not be stopped"
        })`,
      );
  }

  // Replace computer deletes this computer's own old profile: copy it first if sign-ins were
  // never moved to the shared profile. The wait gives way to Clear all, which stops this
  // computer's browser from inside its turn.
  async #adoptBeforeRetire(record: BrowserLedger, signal: AbortSignal): Promise<void> {
    if (await this.#accounts.migrated()) return;
    await this.#contain(record);
    await this.#exclusive(signal, () => this.#accounts.ensure(this.#legacyProfiles(record)));
  }

  // This install's profiles from before sign-ins were shared, the given computer's first.
  // Conversations' slots are never one.
  #legacyProfiles(first: BrowserLedger | undefined): string[] {
    const main = this.#ledger.list().filter((record) => !record.slot);
    const own = first && !first.slot ? [first] : [];
    return [...own, ...main.filter((record) => record.id !== first?.id)].map(
      (record) => browserNames(record.id, record.prefix).profileVolume,
    );
  }

  // One browser at a time opens the saved sign-ins: attaching waits its turn and a browser of
  // another computer lets go first.
  #exclusive<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const previous = this.#attaching;
    const turn = Promise.withResolvers<void>();
    this.#attaching = previous.then(() => turn.promise);
    const waited = new Promise<void>((resolve, reject) => {
      const abort = () => reject(new BrowserStartCancelled());
      signal.addEventListener("abort", abort, { once: true });
      void previous.then(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
      if (signal.aborted) abort();
    });
    return waited.then(run).finally(turn.resolve);
  }

  async #attachProfile(parent: string, check: () => void): Promise<void> {
    for (const holder of await this.#accounts.holders()) {
      const owner = this.#ledger
        .list()
        .find((record) => !record.slot && record.resources.browser === holder);
      if (!owner || owner.parentCellId === parent)
        throw new BrowserLifecycleError("Saved sign-ins are in use");
      await this.stop(owner.parentCellId);
      check();
    }
    if ((await this.#accounts.holders()).length)
      throw new BrowserLifecycleError("Saved sign-ins are in use");
  }

  // A conversation's slot is copied once, from the main one, the first time its browser starts;
  // after that it is its own. The main browser is paused for the part that changes while it runs.
  async #fillSlot(record: BrowserLedger, check: () => void): Promise<void> {
    const found = (await inspectBrowserResources(this.deps.docker, record)).find(
      (entry) => entry.kind === "volumes",
    );
    if (found) return;
    const holders = await this.#accounts.holders();
    const main = this.#ledger
      .list()
      .find((entry) => !entry.slot && entry.resources.browser === holders[0]);
    if (holders.length > 1 || (holders.length === 1 && !main))
      throw new BrowserLifecycleError("Saved sign-ins are in use");
    let running: string | undefined;
    if (main?.resources.browser) {
      const inspected = await this.deps.docker.request<Raw>({
        method: "GET",
        path: browserObjectPath("containers", main.resources.browser, "json"),
      });
      const state = raw(inspected?.State) ? inspected.State : undefined;
      if (state?.Running === true && state.Paused !== true) running = main.resources.browser;
    }
    check();
    const volume = browserNames(record.id, record.prefix).profileVolume;
    await this.deps.docker.request({
      method: "POST",
      path: "/volumes/create",
      body: { Name: volume, Labels: browserLabels(record, "profile") },
    });
    try {
      const { cookiesLeftOut } = await this.#slots.fill(
        volume,
        this.#accounts.volume,
        browserLabels(record, "profile-copy"),
        running,
      );
      if (cookiesLeftOut)
        console.error(
          `a conversation's browser started from the saved sign-ins, without ${cookiesLeftOut} cookies of sites that allow one browser at a time`,
        );
    } catch (error) {
      if (main && error instanceof SlotPauseStuck)
        void this.restart(
          main.parentCellId,
          "The web browser was stuck after a copy of its sign-ins; localDot started it again.",
        ).catch(() => {});
      await this.deps.docker
        .request({ method: "DELETE", path: browserObjectPath("volumes", volume) })
        .catch(() => {});
      throw error;
    }
  }

  #fence(key: string): void {
    if (!ULID_PATTERN.test(key)) throw new BrowserLifecycleError();
    this.#epochs.set(key, (this.#epochs.get(key) ?? 0) + 1);
    this.#ready.delete(key);
    this.#state.set(key, "stopping");
    this.#starting.get(key)?.abort();
    this.#resets.get(key)?.abort();
    this.#changed(key);
  }

  #queued<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.#queues.set(key, next);
    void next
      .finally(() => {
        if (this.#queues.get(key) === next) this.#queues.delete(key);
      })
      .catch(() => {});
    return next;
  }

  #check(key: string, epoch: number, signal: AbortSignal): void {
    const parent = this.#parentOf(key);
    if (
      !parent ||
      signal.aborted ||
      (this.#epochs.get(key) ?? 0) !== epoch ||
      !this.deps.parentAvailable(parent) ||
      !this.deps.store.get(parent)
    )
      throw new BrowserStartCancelled();
  }

  #allocate(key: string): BrowserLedger {
    const parent = this.#parent(key);
    const slot = key === parent ? undefined : key;
    const desktop = this.deps.store.get(parent);
    if (!desktop || this.deps.store.browserFor(parent, slot))
      throw new BrowserLifecycleError("Browser association needs recovery");
    const record: BrowserLedger = {
      v: 1,
      id: ulid(),
      parentCellId: parent,
      ...(slot ? { slot } : {}),
      owner: randomUUID(),
      prefix: this.deps.namePrefix ?? NAME_PREFIX,
      createdAt: new Date().toISOString(),
      scale: desktop.scale,
      phase: "provisioning",
      resources: {},
      keydPort: allocateKeydPort(
        [...this.reservedKeydPorts(), ...(this.deps.externalKeydPorts?.() ?? [])],
        this.deps.store.keydPorts,
      ),
      tokens: { browserd: newCellToken(), stream: newCellToken() },
    };
    if (this.deps.store.getStored(record.id) || this.#ledger.get(record.id))
      throw new BrowserLifecycleError();
    this.#ledger.save(record);
    return record;
  }

  #association(record: BrowserLedger): void {
    const stored = this.deps.store.getStored(record.id);
    if (
      (stored &&
        (stored.kind !== "browser" ||
          stored.parentCellId !== record.parentCellId ||
          stored.slot !== record.slot ||
          stored.docker.profileVolume !== browserNames(record.id, record.prefix).profileVolume)) ||
      this.deps.store.inventoryAll().skipped.includes(record.id)
    )
      throw new BrowserLifecycleError("Browser record ownership changed");
  }

  // Before the readiness clock, since neither depends on the browser: Chrome's install if one is
  // under way, and the one-way hand-over of the sign-ins to it, with no browser holding them.
  async #imageForStart(key: string, epoch: number, signal: AbortSignal): Promise<string> {
    if (this.#engine.pinned) return this.deps.images.browser;
    await this.#engine.settled(signal);
    this.#check(key, epoch, signal);
    if (await this.#engine.handOverPending())
      await this.#exclusive(signal, async () => {
        this.#check(key, epoch, signal);
        const parent = this.#parent(key);
        const own = this.#ledger.forParent(parent);
        if (own) {
          this.#association(own);
          await this.#contain(own);
        }
        await this.#attachProfile(parent, () => this.#check(key, epoch, signal));
        await this.#engine.handOver();
      });
    this.#check(key, epoch, signal);
    return this.#engine.image();
  }

  async #contain(record: BrowserLedger, purge = false): Promise<void> {
    const key = browserKey(record);
    this.#ready.delete(key);
    this.#images.delete(key);
    this.#changed(record.parentCellId);
    const [keyd, docker] = await Promise.allSettled([
      closeBrowserKeyd(this.deps.keyd, record),
      retireBrowserResources(this.deps.docker, record, purge),
    ]);
    if (keyd.status === "rejected" || docker.status === "rejected") {
      record.phase = "failed";
      this.#state.set(key, "failed");
      this.#ledger.save(record);
      const unconfirmed = [
        keyd.status === "rejected" ? "the key service did not confirm its connection closed" : "",
        docker.status === "rejected" ? "Docker did not confirm its containers are gone" : "",
      ];
      throw new BrowserLifecycleError(
        `Browser shutdown could not be confirmed (${unconfirmed.filter(Boolean).join("; ")}); retry Stop`,
      );
    }
    record.resources = {};
    if (record.phase !== "retained") record.phase = "stopped";
    this.#ledger.save(record);
  }

  async #start(key: string, epoch: number, caller: AbortSignal): Promise<ReadyBrowser> {
    this.#check(key, epoch, caller);
    const current = this.endpoints(key);
    if (current) return current;
    const cancel = new AbortController();
    this.#starting.set(key, cancel);
    this.#state.set(key, "starting");
    let image: string;
    try {
      image = await this.#imageForStart(key, epoch, AbortSignal.any([caller, cancel.signal]));
    } catch (error) {
      const cancelled =
        caller.aborted || cancel.signal.aborted || error instanceof BrowserStartCancelled;
      if (this.#starting.get(key) === cancel) this.#starting.delete(key);
      if (this.#state.get(key) === "starting")
        this.#state.set(key, cancelled ? "stopped" : "failed");
      this.#changed(key);
      if (cancelled) throw new BrowserStartCancelled();
      throw new BrowserLifecycleError(
        "Browser start failed while preparing Chrome; its profile has been retained",
      );
    }
    this.#startedAt.set(key, Date.now());
    const readyTimeoutMs = this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(readyTimeoutMs);
    const signal = AbortSignal.any([caller, cancel.signal, timeout]);
    const check = () => this.#check(key, epoch, signal);
    let record: BrowserLedger | undefined;
    let material: Buffer | undefined;
    let stage = "ownership recovery";
    try {
      const parent = this.#parent(key);
      record = this.#ledger.forKey(key);
      if (record) {
        this.#association(record);
        await this.#contain(record);
      } else {
        record = this.#allocate(key);
        await requireFreshBrowserNames(this.deps.docker, record);
      }
      check();
      if (record.phase === "retained")
        record.keydPort = allocateKeydPort(
          [...this.reservedKeydPorts(), ...(this.deps.externalKeydPorts?.() ?? [])],
          this.deps.store.keydPorts,
        );
      record.phase = "provisioning";
      record.tokens = { browserd: newCellToken(), stream: newCellToken() };
      this.#ledger.save(record);
      const names = browserNames(record.id, record.prefix);
      stage = "profile attachment";
      await requireDetachedProfile(this.deps.docker, record);
      check();
      const subnets: string[] = [];
      stage = "network creation";
      for (const [kind, field] of [
        ["internal", "internalNetwork"],
        ["egress", "egressNetwork"],
      ] as const) {
        check();
        const created = await this.deps.docker.request<{ Id?: unknown }>({
          method: "POST",
          path: "/networks/create",
          body: {
            ...browserNetworkSpec(kind, names[field], record.id, parent),
            Labels: browserLabels(record, kind),
          },
        });
        record.resources[field] = dockerId(created?.Id);
        this.#ledger.save(record);
        check();
        const network = (await inspectBrowserResources(this.deps.docker, record)).find(
          (entry) => entry.field === field,
        )?.raw;
        check();
        subnets.push(this.#subnet(network, kind));
      }
      const [internal, egress] = subnets as [string, string];
      if (hostAddress(internal, GATE_OFFSET) === hostAddress(egress, GATE_OFFSET))
        throw new BrowserLifecycleError();
      const cell: BrowserCellRecord = {
        v: 2,
        kind: "browser",
        id: record.id,
        parentCellId: parent,
        ...(record.slot ? { slot: record.slot } : {}),
        createdAt: record.createdAt,
        scale: record.scale,
        keydPort: record.keydPort,
        tokens: { ...record.tokens },
        docker: {
          ...names,
          gateInternalIp: hostAddress(internal, GATE_OFFSET),
          gateEgressIp: hostAddress(egress, GATE_OFFSET),
          browserIp: hostAddress(internal, DESKTOP_OFFSET),
        },
      };
      this.deps.store.saveBrowser(cell);
      stage = "container creation";
      const owned = record;
      const create = async (field: "gate" | "browser", spec: object) => {
        check();
        const created = await this.deps.docker.request<{ Id?: unknown }>({
          method: "POST",
          path: "/containers/create",
          query: { name: names[field] },
          body: {
            ...spec,
            Labels: browserLabels(owned, field),
            ...(field === "browser" ? { Hostname: `browser-${owned.id.toLowerCase()}` } : {}),
          },
        });
        owned.resources[field] = dockerId(created?.Id);
        this.#ledger.save(owned);
        check();
      };
      await create(
        "gate",
        gateSpec(cell, this.deps.images.gate, await (this.deps.relay?.() ?? HOST_RELAY)),
      );
      stage = "profile attachment";
      const limits = browserLimits(this.deps.size?.() ?? DEFAULT_COMPUTER_SIZE);
      const stream = { fullcolor: this.deps.streamFullcolor ?? false };
      await this.#exclusive(signal, async () => {
        check();
        await this.#accounts.ensure(this.#legacyProfiles(this.#ledger.forParent(parent)));
        check();
        if (owned.slot) {
          stage = "profile copy";
          await this.#fillSlot(owned, check);
        } else await this.#attachProfile(parent, check);
        check();
        stage = "container creation";
        await create(
          "browser",
          browserSpec(
            cell,
            image,
            stream,
            owned.slot ? names.profileVolume : this.#accounts.volume,
            limits,
          ),
        );
      });
      const { gate, browser, internalNetwork, egressNetwork } = record.resources;
      if (!gate || !browser || !internalNetwork || !egressNetwork)
        throw new BrowserLifecycleError();
      cell.ownership = { gate, browser, internalNetwork, egressNetwork };
      this.deps.store.saveBrowser(cell);
      const resources = await inspectBrowserResources(this.deps.docker, record);
      check();
      if (resources.filter((entry) => entry.kind !== "volumes").length !== 4)
        throw new BrowserLifecycleError();
      stage = "key listener creation";
      material = await openBrowserKeyd(this.deps.keyd, record, signal);
      check();
      stage = "container startup";
      await this.deps.docker.request({
        method: "POST",
        path: browserObjectPath("containers", gate, "start"),
      });
      check();
      await this.deps.docker.request({
        method: "POST",
        path: browserObjectPath("networks", internalNetwork, "connect"),
        body: {
          Container: gate,
          EndpointConfig: { IPAMConfig: { IPv4Address: cell.docker.gateInternalIp } },
        },
      });
      check();
      await this.deps.docker.request({
        method: "POST",
        path: browserObjectPath("containers", browser, "start"),
      });
      check();
      stage = "private bootstrap";
      await (this.deps.sendInput ?? sendContainerInput)(
        this.deps.docker,
        browser,
        material,
        signal,
      );
      material.fill(0);
      material = undefined;
      check();
      stage = "network verification";
      const inspected = await inspectBrowserResources(this.deps.docker, record);
      check();
      const gateInfo = inspected.find((entry) => entry.field === "gate")?.raw;
      const browserInfo = inspected.find((entry) => entry.field === "browser")?.raw;
      this.#networks(gateInfo, {
        [names.internalNetwork]: [internalNetwork, cell.docker.gateInternalIp],
        [names.egressNetwork]: [egressNetwork, cell.docker.gateEgressIp],
      });
      this.#networks(browserInfo, {
        [names.internalNetwork]: [internalNetwork, cell.docker.browserIp],
      });
      const ports = this.#ports(gateInfo);
      stage = "readiness";
      let instance: string;
      for (;;) {
        check();
        let value: unknown;
        try {
          value = await (this.deps.probe ?? readBrowserHealth)(
            ports.service,
            cell.tokens.browserd,
            signal,
          );
        } catch {
          check();
          const running = (await inspectBrowserResources(this.deps.docker, record)).find(
            (entry) => entry.field === "browser",
          )?.raw.State;
          check();
          if (!raw(running) || running.Running !== true)
            throw new BrowserLifecycleError("Browser process exited during startup");
          await this.#wait(signal);
          continue;
        }
        check();
        const health = validateBrowserHealth(value, cell, record.lastInstance);
        if (health.ready) {
          instance = health.instance;
          break;
        }
        await this.#wait(signal);
      }
      check();
      record.lastInstance = instance;
      record.phase = "active";
      this.#association(record);
      const stored = this.deps.store.getBrowser(record.id);
      if (
        !stored ||
        stored.tokens.browserd !== cell.tokens.browserd ||
        stored.tokens.stream !== cell.tokens.stream ||
        stored.ownership?.browser !== browser ||
        stored.ownership?.gate !== gate
      )
        throw new BrowserLifecycleError();
      this.#ledger.save(record);
      check();
      const ready: ReadyBrowser = {
        browserCellId: record.id,
        parentCellId: parent,
        ...(record.slot ? { slot: record.slot } : {}),
        instance,
        browserd: { baseUrl: `http://127.0.0.1:${ports.service}`, token: cell.tokens.browserd },
        stream: {
          baseUrl: `http://127.0.0.1:${ports.stream}`,
          authorization: `Basic ${Buffer.from(`localdot:${cell.tokens.stream}`).toString("base64")}`,
        },
      };
      this.#ready.set(key, ready);
      this.#images.set(key, image);
      this.#state.set(key, "ready");
      this.#retries.delete(key);
      this.#changed(key);
      if (this.#outages.delete(key)) this.deps.notify?.(key, BROWSER_BACK);
      return structuredClone(ready);
    } catch (error) {
      this.#ready.delete(key);
      if (
        !timeout.aborted &&
        (caller.aborted ||
          cancel.signal.aborted ||
          (this.#epochs.get(key) ?? 0) !== epoch ||
          !this.#parentLive(key))
      ) {
        if (record)
          try {
            await this.#contain(record);
          } catch {}
        if (this.#state.get(key) === "starting") this.#state.set(key, "stopped");
        this.#changed(key);
        throw new BrowserStartCancelled();
      }
      const cause = [
        timeout.aborted
          ? `not ready within ${Math.round(readyTimeoutMs / 1000)} seconds`
          : startCause(error),
        record ? await this.#evidence(record).catch(() => undefined) : undefined,
      ]
        .filter(Boolean)
        .join("; ");
      if (record) {
        try {
          await this.#contain(record);
        } catch {}
        record.phase = "failed";
        try {
          this.#ledger.save(record);
        } catch {}
      }
      this.#state.set(key, "failed");
      this.#changed(key);
      throw new BrowserLifecycleError(
        `Browser start failed during ${stage}${cause ? ` (${cause})` : ""}; its profile has been retained`,
      );
    } finally {
      material?.fill(0);
      if (this.#starting.get(key) === cancel) {
        this.#starting.delete(key);
        this.#startedAt.delete(key);
      }
    }
  }

  // Why a running browser failed, as far as anything can tell: browserd's own report when it
  // answers, else its container's.
  async failure(key: string): Promise<string | undefined> {
    const reported = (await this.supervisor(key))?.lastFailure;
    if (reported) return describeBrowserFailure(reported);
    const record = this.#ledger.forKey(key);
    return record ? this.#evidence(record).catch(() => undefined) : undefined;
  }

  // What the browser container says about how it ended: its exit, an out-of-memory kill and
  // browserd's last own log lines. Nothing from the page.
  async #evidence(record: Pick<BrowserLedger, "resources">): Promise<string | undefined> {
    const container = record.resources.browser;
    if (!container) return undefined;
    const facts: string[] = [];
    const inspected = await this.deps.docker.request<Raw>({
      method: "GET",
      path: browserObjectPath("containers", container, "json"),
    });
    const state = raw(inspected?.State) ? inspected.State : undefined;
    if (state?.Running === false && typeof state.ExitCode === "number")
      facts.push(`the browser container exited with code ${state.ExitCode}`);
    if (state?.OOMKilled === true) facts.push("it ran out of memory");
    const logs = await this.deps.docker.request<Buffer>({
      method: "GET",
      path: browserObjectPath("containers", container, "logs"),
      query: { stdout: "false", stderr: "true", tail: "20" },
      response: "buffer",
      timeoutMs: 5000,
    });
    const lines = Buffer.isBuffer(logs) ? dockerLogLines(logs) : [];
    facts.push(...lines.filter((line) => BROWSERD_LOG.test(line)).slice(-3));
    return facts.length ? facts.join("; ") : undefined;
  }

  #subnet(network: Raw | undefined, kind: "internal" | "egress"): string {
    const ipam = network && raw(network.IPAM) ? network.IPAM : undefined;
    const configs = ipam?.Config;
    const options = network && raw(network.Options) ? network.Options : undefined;
    if (
      network?.Driver !== "bridge" ||
      network.EnableIPv6 !== false ||
      network.Internal !== (kind === "internal") ||
      !Array.isArray(configs) ||
      configs.length !== 1 ||
      !raw(configs[0]) ||
      typeof configs[0].Subnet !== "string" ||
      (kind === "internal" &&
        (configs[0].Gateway || options?.[ISOLATED_GATEWAY_OPTION] !== "isolated"))
    )
      throw new BrowserLifecycleError("Browser network isolation could not be confirmed");
    const subnet = configs[0].Subnet;
    const address = hostAddress(subnet, GATE_OFFSET);
    if (!/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/u.test(address))
      throw new BrowserLifecycleError();
    return subnet;
  }

  #networks(value: Raw | undefined, expected: Record<string, [string, string]>): void {
    const state = value && raw(value.State) ? value.State : undefined;
    const settings = value && raw(value.NetworkSettings) ? value.NetworkSettings : undefined;
    const networks = settings?.Networks;
    if (
      state?.Running !== true ||
      state.Paused !== false ||
      !raw(networks) ||
      Object.keys(networks).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([name, [id, address]]) => {
        const info = networks[name];
        return (
          !raw(info) ||
          info.NetworkID !== id ||
          info.IPAddress !== address ||
          Boolean(info.GlobalIPv6Address)
        );
      })
    )
      throw new BrowserLifecycleError("Browser network attachment is invalid");
  }

  #ports(value: Raw | undefined): { service: number; stream: number } {
    const settings = value && raw(value.NetworkSettings) ? value.NetworkSettings : undefined;
    const ports = settings?.Ports;
    if (
      !raw(ports) ||
      Object.keys(ports).some((key) => key !== GATE_PORTS.desktopd && key !== GATE_PORTS.stream)
    )
      throw new BrowserLifecycleError("Browser gate has unexpected published ports");
    const port = (key: string) => {
      const bindings = raw(ports) ? ports[key] : undefined;
      if (
        !Array.isArray(bindings) ||
        bindings.length !== 1 ||
        !raw(bindings[0]) ||
        bindings[0].HostIp !== "127.0.0.1" ||
        typeof bindings[0].HostPort !== "string" ||
        !/^[0-9]{4,5}$/u.test(bindings[0].HostPort)
      )
        throw new BrowserLifecycleError("Browser gate is not loopback-only");
      const number = Number(bindings[0].HostPort);
      if (number < 1024 || number > 65535) throw new BrowserLifecycleError();
      return number;
    };
    const service = port(GATE_PORTS.desktopd),
      stream = port(GATE_PORTS.stream);
    if (service === stream) throw new BrowserLifecycleError();
    return { service, stream };
  }

  #wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const end = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new BrowserLifecycleError());
      };
      const timer = setTimeout(end, 100);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
