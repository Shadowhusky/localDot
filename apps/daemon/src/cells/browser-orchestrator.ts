import { randomUUID } from "node:crypto";
import { type ComputerSize, DEFAULT_COMPUTER_SIZE, ULID_PATTERN, ulid } from "@localdot/protocol";
import {
  type BrowserStatus,
  BrowserSupervisorState,
} from "../../../../packages/protocol/src/browser-control.ts";
import type { ComputerResetSource } from "../../../../packages/protocol/src/computer-reset.ts";
import {
  type BrowserKeydClient,
  closeBrowserKeyd,
  openBrowserKeyd,
} from "../keyd/browser-wiring.ts";
import { KeydError } from "../keyd/client.ts";
import { AccountsProfile } from "./accounts-profile.ts";
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
} from "./browser-ledger.ts";
import {
  browserLabels,
  browserObjectPath,
  inspectBrowserResources,
  requireDetachedProfile,
  requireFreshBrowserNames,
  retireBrowserResources,
} from "./browser-resources.ts";
import { browserNames, browserNetworkSpec, browserSpec } from "./browser-spec.ts";
import { browserLimits } from "./computer-size.ts";
import { type DockerClient, DockerError } from "./docker.ts";
import type { BrowserImages } from "./images.ts";
import { hostAddress } from "./ipv4.ts";
import { allocateKeydPort } from "./ports.ts";
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
  // A word to the task running on this computer.
  notify?(parentCellId: string, text: string): void;
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

// Docker's non-TTY log stream: eight-byte frame headers, then the text. A malformed frame ends it.
function containerLog(buffer: Buffer): string[] {
  const text: string[] = [];
  for (let offset = 0; offset + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + length > buffer.length) break;
    text.push(buffer.subarray(offset + 8, offset + 8 + length).toString("utf8"));
    offset += 8 + length;
  }
  return text.join("").split("\n").filter(Boolean);
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
  #attaching: Promise<void> = Promise.resolve();

  subscribe(listener: (parentCellId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #changed(parentCellId: string): void {
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
  }

  // The computer whose browser has the saved sign-ins open, is opening them, or still has a
  // container that may hold them.
  profileHolder(): string | undefined {
    const [active] = [...this.#ready.keys(), ...this.#starting.keys()];
    if (active) return active;
    try {
      return this.#ledger.list().find((record) => record.resources.browser)?.parentCellId;
    } catch {
      return undefined;
    }
  }

  // Signs out of every site: each browser lets go of the profile, which is then made again empty,
  // and the profiles computers kept for themselves before sign-ins were shared are deleted.
  clearAccounts(): Promise<void> {
    const parents = this.#ledger.list().map((record) => record.parentCellId);
    return this.#exclusive(new AbortController().signal, async () => {
      await Promise.all(parents.map((parent) => this.#stop(parent, true)));
      await this.#accounts.wipe();
    });
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

  get(parentCellId: string): { id: string; parentCellId: string; state: CellState } | undefined {
    const record = this.#ledger.forParent(parentCellId);
    return record
      ? {
          id: record.id,
          parentCellId,
          state:
            this.#state.get(parentCellId) ??
            (record.phase === "stopped" || record.phase === "retained" ? "stopped" : "failed"),
        }
      : undefined;
  }

  endpoints(parentCellId: string): ReadyBrowser | undefined {
    const ready = this.#ready.get(parentCellId);
    if (!ready || !this.deps.parentAvailable(parentCellId) || !this.deps.store.get(parentCellId))
      return undefined;
    return structuredClone(ready);
  }

  // How the running browser answers now: "silent" when it doesn't, "restarting" while browserd
  // starts its Chromium again in place, "unready" when it can no longer be controlled; undefined
  // when none is running.
  async health(
    parentCellId: string,
  ): Promise<"ready" | "restarting" | "unready" | "silent" | undefined> {
    const ready = this.#ready.get(parentCellId);
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
    return (await this.supervisor(parentCellId))?.state === "restarting" ? "restarting" : "unready";
  }

  // browserd's report on its Chromium; undefined from an older image or a browser not running.
  async supervisor(parentCellId: string): Promise<BrowserSupervisorState | undefined> {
    const ready = this.#ready.get(parentCellId);
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
  noteProblem(parentCellId: string, text: string): void {
    this.#problems.set(parentCellId, { text: text.slice(0, 600), at: new Date().toISOString() });
  }

  problem(parentCellId: string): string | undefined {
    return this.#problems.get(parentCellId)?.text;
  }

  // When the failed browser is started again by itself; `undefined` once that was given up.
  noteRetry(parentCellId: string, at: Date | undefined): void {
    this.#retries.set(parentCellId, at ? { at: at.toISOString() } : {});
  }

  // Someone could not have the browser; when it runs again, the task is told.
  noteOutage(parentCellId: string): void {
    this.#outages.add(parentCellId);
  }

  async status(parentCellId: string): Promise<BrowserStatus> {
    const noted = this.#problems.get(parentCellId);
    const problem = noted ? { problem: noted.text, problemAt: noted.at } : {};
    const blocked =
      this.deps.unavailable?.(parentCellId) ??
      (this.deps.parentAvailable(parentCellId) ? undefined : COMPUTER_STOPPED);
    if (blocked) return { state: "off", ...blocked };
    const locked = this.deps.keysLocked?.() ? KEYS_LOCKED : undefined;
    if (this.#ready.has(parentCellId)) {
      const supervisor = await this.supervisor(parentCellId);
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
    const state = this.get(parentCellId)?.state;
    if (state === "failed") {
      const retry = this.#retries.get(parentCellId);
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
    const startedAt = this.#startedAt.get(parentCellId);
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

  // Stops this computer's browser and starts it again on the same profile.
  async restart(parentCellId: string, reason: string): Promise<ReadyBrowser> {
    this.noteProblem(parentCellId, reason);
    await this.stop(parentCellId);
    return this.start(parentCellId);
  }

  start(parentCellId: string, signal = new AbortController().signal): Promise<ReadyBrowser> {
    if (!ULID_PATTERN.test(parentCellId)) return Promise.reject(new BrowserLifecycleError());
    const epoch = this.#epochs.get(parentCellId) ?? 0;
    const started = this.#queued(parentCellId, () => this.#start(parentCellId, epoch, signal));
    void started.catch(() => this.#outages.add(parentCellId));
    return started;
  }

  stop(parentCellId: string): Promise<void> {
    return this.#stop(parentCellId, false);
  }

  #stop(parentCellId: string, purgeProfile: boolean): Promise<void> {
    this.#fence(parentCellId);
    return this.#queued(parentCellId, async () => {
      const record = this.#ledger.forParent(parentCellId);
      if (record) await this.#contain(record, purgeProfile);
      else if (this.deps.store.browserFor(parentCellId))
        throw new BrowserLifecycleError("Browser recovery ownership is missing");
      this.#state.set(parentCellId, "stopped");
      this.#changed(parentCellId);
    });
  }

  remove(parentCellId: string, options: { purgeProfile?: boolean } = {}): Promise<void> {
    this.#fence(parentCellId);
    return this.#queued(parentCellId, async () => {
      const record = this.#ledger.forParent(parentCellId);
      if (!record) {
        if (this.deps.store.browserFor(parentCellId))
          throw new BrowserLifecycleError("Browser recovery ownership is missing");
        return;
      }
      await this.#contain(record, options.purgeProfile === true);
      this.#association(record);
      this.deps.store.remove(record.id);
      if (options.purgeProfile) this.#ledger.remove(record);
      else {
        record.phase = "retained";
        this.#ledger.save(record);
      }
      this.#state.set(parentCellId, "removed");
    });
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
    for (const record of records) this.#fence(record.parentCellId);
    const inventory = this.deps.store.inventoryAll();
    const unknown =
      inventory.skipped.length > 0 ||
      inventory.records.some(
        (record) =>
          record.kind === "browser" &&
          !records.some(
            (owner) => owner.id === record.id && owner.parentCellId === record.parentCellId,
          ),
      );
    const result = await Promise.allSettled(
      records.map((record) => this.stop(record.parentCellId)),
    );
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
  #legacyProfiles(first: BrowserLedger): string[] {
    return [first, ...this.#ledger.list().filter((record) => record.id !== first.id)].map(
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
      const owner = this.#ledger.list().find((record) => record.resources.browser === holder);
      if (!owner || owner.parentCellId === parent)
        throw new BrowserLifecycleError("Saved sign-ins are in use");
      await this.stop(owner.parentCellId);
      check();
    }
    if ((await this.#accounts.holders()).length)
      throw new BrowserLifecycleError("Saved sign-ins are in use");
  }

  #fence(parent: string): void {
    if (!ULID_PATTERN.test(parent)) throw new BrowserLifecycleError();
    this.#epochs.set(parent, (this.#epochs.get(parent) ?? 0) + 1);
    this.#ready.delete(parent);
    this.#state.set(parent, "stopping");
    this.#starting.get(parent)?.abort();
    this.#resets.get(parent)?.abort();
    this.#changed(parent);
  }

  #queued<T>(parent: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(parent) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.#queues.set(parent, next);
    void next
      .finally(() => {
        if (this.#queues.get(parent) === next) this.#queues.delete(parent);
      })
      .catch(() => {});
    return next;
  }

  #check(parent: string, epoch: number, signal: AbortSignal): void {
    if (
      signal.aborted ||
      (this.#epochs.get(parent) ?? 0) !== epoch ||
      !this.deps.parentAvailable(parent) ||
      !this.deps.store.get(parent)
    )
      throw new BrowserStartCancelled();
  }

  #allocate(parent: string): BrowserLedger {
    const desktop = this.deps.store.get(parent);
    if (!desktop || this.deps.store.browserFor(parent))
      throw new BrowserLifecycleError("Browser association needs recovery");
    const record: BrowserLedger = {
      v: 1,
      id: ulid(),
      parentCellId: parent,
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
          stored.docker.profileVolume !== browserNames(record.id, record.prefix).profileVolume)) ||
      this.deps.store.inventoryAll().skipped.includes(record.id)
    )
      throw new BrowserLifecycleError("Browser record ownership changed");
  }

  async #contain(record: BrowserLedger, purge = false): Promise<void> {
    this.#ready.delete(record.parentCellId);
    this.#changed(record.parentCellId);
    const [keyd, docker] = await Promise.allSettled([
      closeBrowserKeyd(this.deps.keyd, record),
      retireBrowserResources(this.deps.docker, record, purge),
    ]);
    if (keyd.status === "rejected" || docker.status === "rejected") {
      record.phase = "failed";
      this.#state.set(record.parentCellId, "failed");
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

  async #start(parent: string, epoch: number, caller: AbortSignal): Promise<ReadyBrowser> {
    this.#check(parent, epoch, caller);
    const current = this.endpoints(parent);
    if (current) return current;
    const cancel = new AbortController();
    this.#starting.set(parent, cancel);
    this.#startedAt.set(parent, Date.now());
    const readyTimeoutMs = this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(readyTimeoutMs);
    const signal = AbortSignal.any([caller, cancel.signal, timeout]);
    const check = () => this.#check(parent, epoch, signal);
    let record: BrowserLedger | undefined;
    let material: Buffer | undefined;
    let stage = "ownership recovery";
    this.#state.set(parent, "starting");
    try {
      record = this.#ledger.forParent(parent);
      if (record) {
        this.#association(record);
        await this.#contain(record);
      } else {
        record = this.#allocate(parent);
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
      await this.#exclusive(signal, async () => {
        check();
        await this.#accounts.ensure(this.#legacyProfiles(owned));
        check();
        await this.#attachProfile(parent, check);
        stage = "container creation";
        await create(
          "browser",
          browserSpec(
            cell,
            this.deps.images.browser,
            { fullcolor: this.deps.streamFullcolor ?? false },
            this.#accounts.volume,
            browserLimits(this.deps.size?.() ?? DEFAULT_COMPUTER_SIZE),
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
        instance,
        browserd: { baseUrl: `http://127.0.0.1:${ports.service}`, token: cell.tokens.browserd },
        stream: {
          baseUrl: `http://127.0.0.1:${ports.stream}`,
          authorization: `Basic ${Buffer.from(`localdot:${cell.tokens.stream}`).toString("base64")}`,
        },
      };
      this.#ready.set(parent, ready);
      this.#state.set(parent, "ready");
      this.#retries.delete(parent);
      this.#changed(parent);
      if (this.#outages.delete(parent)) this.deps.notify?.(parent, BROWSER_BACK);
      return structuredClone(ready);
    } catch (error) {
      this.#ready.delete(parent);
      if (
        !timeout.aborted &&
        (caller.aborted ||
          cancel.signal.aborted ||
          (this.#epochs.get(parent) ?? 0) !== epoch ||
          !this.deps.parentAvailable(parent) ||
          !this.deps.store.get(parent))
      ) {
        if (record)
          try {
            await this.#contain(record);
          } catch {}
        if (this.#state.get(parent) === "starting") this.#state.set(parent, "stopped");
        this.#changed(parent);
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
      this.#state.set(parent, "failed");
      this.#changed(parent);
      throw new BrowserLifecycleError(
        `Browser start failed during ${stage}${cause ? ` (${cause})` : ""}; its profile has been retained`,
      );
    } finally {
      material?.fill(0);
      if (this.#starting.get(parent) === cancel) {
        this.#starting.delete(parent);
        this.#startedAt.delete(parent);
      }
    }
  }

  // Why a running browser failed, as far as anything can tell: browserd's own report when it
  // answers, else its container's.
  async failure(parentCellId: string): Promise<string | undefined> {
    const reported = (await this.supervisor(parentCellId))?.lastFailure;
    if (reported) return describeBrowserFailure(reported);
    const record = this.#ledger.forParent(parentCellId);
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
    const lines = Buffer.isBuffer(logs) ? containerLog(logs) : [];
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
