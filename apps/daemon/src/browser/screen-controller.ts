import { setTimeout as sleep } from "node:timers/promises";
import { type ManualInput, ULID_PATTERN, ulid } from "@localdot/protocol";
import type {
  BrowserActionPermit,
  BrowserAgentOwner,
  BrowserManualPermit,
  BrowserStatus,
} from "../../../../packages/protocol/src/browser-control.ts";
import type { BrowserDownloadBinding } from "../../../../packages/protocol/src/browser-downloads.ts";
import type { BrowserSecretRequest } from "../../../../packages/protocol/src/browser-secret.ts";
import {
  ScreenGeometry,
  ScreenName,
  ScreenSwitchData,
} from "../../../../packages/protocol/src/screens.ts";
import { BrowserLifecycleError } from "../cells/browser-ledger.ts";
import type { BrowserOrchestrator, ReadyBrowser } from "../cells/browser-orchestrator.ts";
import { BrowserClient, BrowserClientError, type BrowserScope } from "./client.ts";
import type { DownloadCollection } from "./download-pump.ts";

export interface ScreenScope extends BrowserScope {
  readonly sessionId: string;
  readonly generation: number;
}
export interface ScreenSelection {
  readonly screen: ScreenName;
  readonly cellId: string;
  readonly geometry: ScreenGeometry;
  readonly revision: number;
}
export interface ScreenLease extends BrowserScope {
  readonly selection: ScreenSelection;
  finish(): void;
}
type Client = Pick<
  BrowserClient,
  | "health"
  | "tabs"
  | "control"
  | "close"
  | "observe"
  | "input"
  | "type"
  | "navigate"
  | "clock"
  | "settle"
  | "lookup"
  | "read"
> &
  Partial<
    Pick<
      BrowserClient,
      | "manual"
      | "uploadChooser"
      | "upload"
      | "signIn"
      | "openTab"
      | "enterWindow"
      | "ownTabs"
      | "signInPage"
      | "manualSecret"
    >
  >;
interface BrowserOwner {
  readonly endpoint: ReadyBrowser;
  readonly client: Client;
  revision: number;
  permit?: BrowserActionPermit;
  manualPermit?: BrowserManualPermit;
  userPermit?: BrowserManualPermit;
  // A grant asked for and not yet confirmed: it may be in force whatever became of the request.
  granting?: BrowserAgentOwner;
  tabId?: string;
  revoking?: Promise<void>;
}
export interface ScreenControllerDeps {
  readonly sessionId: string;
  readonly parentCellId: string;
  readonly desktopGeometry: ScreenGeometry;
  desktopReady(): boolean;
  browser: Pick<BrowserOrchestrator, "start" | "endpoints" | "stop" | "get"> &
    Partial<
      Pick<
        BrowserOrchestrator,
        "health" | "status" | "failure" | "noteProblem" | "noteOutage" | "problem"
      >
    >;
  // Why the web browser could not be shown, for the daemon's log.
  report?(message: string): void;
  // The browser outlives sessions, so its control revisions are counted across them.
  revision?(instance: string): number;
  client?(endpoint: ReadyBrowser): Client;
  downloads?(
    endpoint: ReadyBrowser,
    binding: BrowserDownloadBinding,
    scope: BrowserScope,
  ): DownloadCollection;
  attachRecording(selection: ScreenSelection, scope: BrowserScope): Promise<void>;
  // Must synchronously fence recording admission before returning its drain promise.
  fenceRecording(): Promise<void>;
  publish(data: ScreenSwitchData): void;
  // Synchronously stop agent admission, then physically contain both cells independently.
  fenceSession(): void;
  contain(): Promise<void>;
  // The lane of the browser `key`: changing what a task holds of a screen waits for its turn.
  turn?(signal: AbortSignal, key: string): Promise<{ release(): void }>;
  // What a screen shows is about to change to this task's, and has: its recording, and no other
  // task's, takes in what comes after.
  coming?(screen: ScreenName, key: string): void;
  up?(screen: ScreenName): void;
  // A word to dot, with its next look at its inbox.
  remind?(text: string): void;
  // A new conversation's task first sees the web browser on a blank tab, the page the task before
  // it left kept in a tab behind; a task that continues a conversation carries on from that page,
  // in the window of the task it continues.
  readonly freshTab?: boolean;
  readonly continues?: string;
  // Which web browser the task uses, picked at its first use; the computer's main one without it.
  readonly lane?: {
    claim(signal: AbortSignal): Promise<string>;
    release(): void;
  };
}
export class ScreenControlError extends Error {
  constructor() {
    super("Screen control is no longer available.");
    this.name = "ScreenControlError";
  }
}
class SignInStillHeldError extends ScreenControlError {}

// What a task hears when its window did not survive something it waited for.
export const BROWSER_WINDOW_LOST =
  "localDot: your web browser window was closed while you waited (the browser restarted, or was relaunched for a sign-in). Saved sign-ins are kept. A new blank window is yours: open your page again with browser_navigate.";

// What a task hears when its first look couldn't read the web browser, and it starts on the desktop.
export const BROWSER_FIRST_LOOK =
  "localDot: the web browser didn't answer in time for your first look at the screen, so you start on the desktop. Its saved sign-ins are kept: switch_screen to it when you need it, and if it still doesn't answer, tell the user. Don't sign in on the desktop's Chromium or open another browser instead.";

export class ScreenUnavailableError extends Error {
  constructor(
    readonly screen: ScreenName,
    starting = false,
    readonly problem?: string,
    readonly status?: BrowserStatus,
  ) {
    super(
      screen === "desktop"
        ? "The desktop isn't ready right now. Try switching to it again in a moment."
        : status
          ? browserUnavailableText(status)
          : starting
            ? "The web browser is still starting. Try switching to it again in a few seconds."
            : `The web browser couldn't open.${problem ? ` What went wrong: ${problem.replace(/\.$/u, "")}.` : ""} localDot restarts it by itself and keeps the saved sign-ins. Don't sign in on the desktop's Chromium or launch another browser as a workaround. Retry the visible web browser once after about 20 seconds (switch_screen with restart: true restarts it if it stays stuck), then tell the user what you couldn't do if it still fails.`,
    );
    this.name = "ScreenUnavailableError";
  }
}

const BUSY_ADVICE =
  "a busy page can keep it waiting for seconds. Don't restart the web browser for this, which closes its pages, and don't sign in on the desktop's Chromium or open another browser instead. If it keeps happening, tell the user the page is too busy to work with.";

// The web browser runs, but its page didn't answer in time: nothing was done there.
export class BrowserBusyError extends ScreenUnavailableError {
  constructor(onDesktop = false) {
    super("browser");
    this.name = "BrowserBusyError";
    this.message = onDesktop
      ? `The web browser is running, but its page didn't answer in time, so you're on the desktop: switch to it again in a moment; ${BUSY_ADVICE}`
      : `The web browser is running, but its page didn't answer in time. Nothing was done there: try again in a moment; ${BUSY_ADVICE}`;
  }
}

// The web browser runs and its page answers, but one of the browser's own surfaces is over the
// page: a person closes one in a click, and a restart only meets the site's next one.
export class BrowserCoveredError extends BrowserBusyError {
  constructor(onDesktop = false) {
    super(onDesktop);
    this.name = "BrowserCoveredError";
    this.message = `The web browser is showing one of its own dialogs, bubbles or menus over the page, so ${
      onDesktop ? "you're on the desktop" : "nothing was done there"
    } and the page can't be read or used until it closes. Ask the user to take control and close it. Don't restart the web browser for this: a site that brings it up does so again. Don't sign in on the desktop's Chromium or open another browser instead.`;
  }
}

const seconds = (iso: string, now: number) =>
  `${Math.max(1, Math.round((Date.parse(iso) - now) / 1000))} seconds`;

// What dot hears when the web browser can't be shown, from the daemon's own account of it: why,
// what clears it and when localDot tries again, and that it will be told once the browser runs.
export function browserUnavailableText(status: BrowserStatus, now = Date.now()): string {
  const what =
    status.state === "starting"
      ? `The web browser is still starting${status.readyBy ? `; it is ready, or has failed, within ${seconds(status.readyBy, now)}` : ""}.`
      : `The web browser couldn't open (${status.reason ?? status.state}): ${(status.problem ?? "it isn't running").replace(/\.$/u, "")}.`;
  const next =
    status.reason === "failed" && !status.retryAt
      ? "localDot has stopped starting it by itself: switch_screen with restart: true tries once more (open pages are lost); if that fails too, tell the user what you couldn't do."
      : status.state === "restarting"
        ? "It restarts by itself within seconds; switch to it again in about 20 seconds."
        : `${status.clears ? `${status.clears} ` : ""}${status.retryAt ? `localDot tries again in about ${seconds(status.retryAt, now)}. ` : ""}You'll get a note from localDot when it is running; until then don't retry it: do what doesn't need it, or wait.`;
  return `${what} ${next} Its saved sign-ins are kept. Don't sign in on the desktop's Chromium or open another browser instead.`;
}

// dot may restart the web browser itself, once a minute at most; a request sooner reuses the
// browser that restart started.
export const BROWSER_RESTART_REQUEST_MS = 60_000;
// While browserd restarts its Chromium in place, a switch waits this long for it.
const RESTART_WAIT_MS = 500;
const RESTART_WAITS = 40;
const BUSY_WAIT_MS = 100;
const BUSY_WAITS = 50;
// browserd finds the page in front by reading every tab of the window and the page's layout, each
// on its page's main thread, which a busy page answers only between its long tasks: seconds a probe.
// The search goes on while browserd answers, each request within the client's own bound.
export const BROWSER_FOREGROUND_MS = 15_000;

// This object belongs to a session, not a model call. Display selection never grants
// input: every operation needs a lease bound to this screen, generation and revision.
export class ScreenController {
  readonly #desktopGeometry: ScreenGeometry;
  #selection: ScreenSelection;
  #browser: BrowserOwner | undefined;
  #ownerGeneration: number | undefined;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #epoch = 0;
  #held = false;
  // The user, not a brain's retirement, took it: the whole browser is theirs.
  #userHeld = false;
  // The user's hold has reached the web browser while dot's screen stays the desktop.
  #userBrowser = false;
  #failed = false;
  #closed = false;
  #returning = false;
  #control = new AbortController();
  #actions = new AbortController();
  #manual = new AbortController();
  #userReady = false;
  readonly #active = new Set<Promise<void>>();
  readonly #leases = new WeakSet<ScreenLease>();
  readonly #tabs = new WeakMap<ScreenLease, string>();
  #holding: Promise<void> | undefined;
  #regranting: Promise<void> | undefined;
  #containment: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #finishing = false;
  #downloads: DownloadCollection | undefined;
  #downloadEpoch = 0;
  #restartRequested = Number.NEGATIVE_INFINITY;
  readonly #downloadRetiring = new Set<Promise<void>>();
  #freshTab: boolean;
  // The browser this task uses: its computer's id for the main one, else its conversation's slot.
  #key: string;
  #claiming: Promise<void> | undefined;
  #picked = false;
  // The tabs of the task's windows when it last came forward.
  #windowTabs: ReadonlySet<string> = new Set();

  constructor(private readonly deps: ScreenControllerDeps) {
    if (!ULID_PATTERN.test(deps.sessionId) || !ULID_PATTERN.test(deps.parentCellId))
      throw new ScreenControlError();
    this.#freshTab = deps.freshTab === true;
    this.#key = deps.parentCellId;
    this.#desktopGeometry = Object.freeze(ScreenGeometry.parse(deps.desktopGeometry));
    this.#selection = Object.freeze({
      screen: "desktop",
      cellId: deps.parentCellId,
      geometry: this.#desktopGeometry,
      revision: 0,
    });
  }

  get selection(): ScreenSelection {
    return this.#selection;
  }

  // The web browser the task uses; the computer's main one until it has picked.
  get browserKey(): string {
    return this.#key;
  }

  // Whether the task has picked its browser, which then has a lane of its own.
  get browserPicked(): boolean {
    return this.#picked;
  }

  // Picks the task's browser once, before anything waits on that browser's lane.
  async #claim(scope: BrowserScope): Promise<void> {
    const lane = this.deps.lane;
    if (!lane) return;
    this.#claiming ??= lane.claim(scope.signal).then(
      (key) => {
        this.#key = key;
        this.#picked = true;
      },
      (error: unknown) => {
        this.#claiming = undefined;
        throw error;
      },
    );
    await this.#claiming;
    scope.check();
  }

  availability(): {
    desktop: boolean;
    browser: "attached" | "not_open" | "unavailable";
    selected: ScreenName;
  } {
    return {
      desktop: this.deps.desktopReady(),
      browser:
        this.#closed || this.#failed ? "unavailable" : this.#browser ? "attached" : "not_open",
      selected: this.#selection.screen,
    };
  }

  lease(raw: ScreenScope): ScreenLease {
    const scope = this.#scope(raw);
    const epoch = this.#epoch;
    const selection = this.#selection;
    if (this.#actions.signal.aborted) this.#actions = new AbortController();
    const signal = AbortSignal.any([scope.signal, this.#actions.signal]);
    let finished = false;
    const check = () => {
      scope.check();
      if (
        finished ||
        signal.aborted ||
        this.#closed ||
        this.#failed ||
        this.#held ||
        this.#pending > 0 ||
        epoch !== this.#epoch ||
        selection !== this.#selection ||
        (this.#ownerGeneration !== undefined && this.#ownerGeneration !== scope.generation)
      )
        throw new ScreenControlError();
      this.#checkTarget();
    };
    check();
    this.#ownerGeneration ??= scope.generation;
    const done = Promise.withResolvers<void>();
    this.#active.add(done.promise);
    const lease = Object.freeze({
      selection,
      signal,
      check,
      finish: () => {
        if (finished) return;
        finished = true;
        this.#active.delete(done.promise);
        done.resolve();
      },
    });
    this.#leases.add(lease);
    if (selection.screen === "browser" && this.#browser?.tabId)
      this.#tabs.set(lease, this.#browser.tabId);
    return lease;
  }

  // Permit data remains daemon-private. Callers must use the accompanying lease for
  // every read/input and close it only after their physical request has settled.
  browserAccess(lease: ScreenLease): {
    client: Pick<
      Client,
      "observe" | "input" | "type" | "navigate" | "clock" | "settle" | "lookup" | "read"
    > &
      Partial<Pick<Client, "uploadChooser" | "upload">>;
    permit: BrowserActionPermit;
    tabId: string;
  } {
    if (!this.#leases.has(lease)) throw new ScreenControlError();
    lease.check();
    const owner = this.#browser;
    if (
      lease.selection !== this.#selection ||
      this.#selection.screen !== "browser" ||
      !owner?.permit ||
      !owner.tabId
    )
      throw new ScreenControlError();
    return {
      client: owner.client,
      permit: owner.permit,
      tabId: this.#tabs.get(lease) ?? owner.tabId,
    };
  }

  // A read follows the visible tab, including popup sign-in windows. Input stays pinned to
  // the tab admitted for its lease; discovering a popup must never replay an old click there.
  async refreshBrowser(lease: ScreenLease): Promise<void> {
    if (!this.#leases.has(lease)) throw new ScreenControlError();
    lease.check();
    if (lease.selection.screen !== "browser") return;
    const owner = this.#browser;
    if (!owner?.permit) throw new ScreenControlError();
    let tabId: string;
    try {
      tabId = await this.#foreground(owner, this.#browserScope(owner, lease));
    } catch (error) {
      // A read that lost its screen hears so; one that still holds it was kept waiting by the page.
      if (error instanceof BrowserBusyError) {
        lease.check();
        this.#reportBrowser(error, "the web browser couldn't be read");
      }
      throw error;
    }
    lease.check();
    owner.tabId = tabId;
    this.#tabs.set(lease, tabId);
  }

  // restart: dot found the web browser stuck and asks for it to be started again first. daemon: the
  // daemon, not dot, moves the task, as when its first look can't read the web browser.
  async switchTo(
    screen: ScreenName,
    raw: ScreenScope,
    options: { restart?: boolean; daemon?: boolean } = {},
  ): Promise<ScreenSwitchData> {
    if (!ScreenName.safeParse(screen).success) return Promise.reject(new ScreenControlError());
    return this.#switch(screen, this.#scope(raw), false, {
      restart: screen === "browser" && options.restart === true,
      daemon: options.daemon === true,
    });
  }

  // The web browser as the daemon sees it, for dot's work context.
  async browserStatus() {
    return this.deps.browser.status?.(this.#key);
  }

  // The user's own hold opens a page in the web browser for them before they take it. The grant
  // for this one navigation ends at the takeover that follows; nothing else may use it.
  async openForUser(url: string, raw: ScreenScope): Promise<void> {
    const scope = this.#scope(raw);
    if (this.#held || this.#ownerGeneration !== undefined) throw new ScreenControlError();
    await this.#switch("browser", scope, false, { forUser: true });
    const lease = this.lease(scope);
    try {
      const { client, permit, tabId } = this.browserAccess(lease);
      await client.navigate(permit, tabId, url, lease);
    } catch (error) {
      // The web browser is showing; the user can still go to the page themselves.
      scope.check();
      this.deps.report?.(
        `the page couldn't open in the web browser: ${error instanceof BrowserClientError ? error.message : "unknown"}`,
      );
    } finally {
      lease.finish();
    }
  }

  // The user's hold reaches both screens, and the web browser is theirs from the first input they
  // send it: a hold that stays on the desktop takes nothing from a task at work there, and costs no
  // page its reload when the hold ends. dot's own screen doesn't change.
  async reachBrowser(scope: BrowserScope): Promise<void> {
    if (
      !this.#held ||
      !this.#userHeld ||
      !this.#userReady ||
      this.#returning ||
      this.#closed ||
      this.#failed
    )
      throw new ScreenControlError();
    if (this.#selection.screen === "browser" || (this.#userBrowser && this.#browser?.manualPermit))
      return;
    this.#userBrowser = true;
    try {
      await this.#prepare(scope);
      scope.check();
      await this.#revoke();
      scope.check();
    } catch (error) {
      this.#userBrowser = false;
      throw error;
    }
  }

  get #userOnBrowser(): boolean {
    return this.#selection.screen === "browser" || this.#userBrowser;
  }

  // The session's manual lease is required in addition to the physical user grant.
  // It expires before handback, even while the underlying native request is draining.
  manualAccess(scope: BrowserScope) {
    try {
      return this.#manualAccess(scope);
    } catch (error) {
      this.#regrant();
      throw error;
    }
  }

  #manualAccess(scope: BrowserScope) {
    const owner = this.#browser;
    const permit = this.#userHeld ? owner?.manualPermit : undefined;
    if (!owner?.client.manual || !permit) throw new ScreenControlError();
    const send = owner.client.manual.bind(owner.client);
    const selection = this.#selection;
    const epoch = this.#epoch;
    const signal = AbortSignal.any([scope.signal, this.#manual.signal]);
    let finished = false;
    const check = () => {
      signal.throwIfAborted();
      scope.check();
      if (
        finished ||
        !this.#held ||
        !this.#userReady ||
        this.#returning ||
        this.#pending ||
        this.#closed ||
        this.#failed ||
        !this.deps.desktopReady() ||
        selection !== this.#selection ||
        !this.#userOnBrowser ||
        !owner ||
        owner !== this.#browser ||
        !permit ||
        owner.manualPermit !== permit ||
        !owner.client.manual
      )
        throw new ScreenControlError();
      this.#checkBrowser(owner);
    };
    check();
    const done = Promise.withResolvers<void>();
    this.#active.add(done.promise);
    return {
      selection,
      signal,
      check,
      signIn: async (start: boolean) => {
        check();
        const health = await owner.client.health({ signal, check });
        check();
        if (!health.signIn || !owner.client.signIn) return { available: false as const };
        if (!start) return { available: true as const, ...health.signIn };
        await this.#retireDownloads();
        check();
        const result = await owner.client.signIn(permit, "signin", { signal, check });
        check();
        return { available: true as const, ...result };
      },
      // Sign-in mode has no page to read: browserd refuses these, and only the mode's own path runs.
      signInPage: async (fields: boolean) => {
        check();
        return (await owner.client.signInPage?.(permit, fields, { signal, check })) ?? null;
      },
      fillSecret: (tabId: string, request: BrowserSecretRequest) => {
        check();
        if (!owner.client.manualSecret) throw new ScreenControlError();
        return owner.client.manualSecret(permit, tabId, request, { signal, check });
      },
      input: (input: ManualInput, cancel?: AbortSignal) => {
        check();
        return send(permit, input, {
          signal: cancel ? AbortSignal.any([signal, cancel]) : signal,
          check,
        });
      },
      finish: () => {
        if (finished) return;
        finished = true;
        this.#active.delete(done.promise);
        done.resolve();
      },
      // Recovery outlives the input lease. A fresh user grant drains the old browser
      // actions before acknowledging it, without reading private fields, replaying
      // uncertain input, reloading the page, or returning control to the agent.
      confirm: async () => {
        const current = () => {
          if (
            epoch !== this.#epoch ||
            selection !== this.#selection ||
            owner !== this.#browser ||
            !this.#held ||
            !this.#userReady ||
            this.#returning ||
            this.#pending ||
            this.#closed ||
            this.#failed ||
            !this.deps.desktopReady()
          )
            throw new ScreenControlError();
          this.#checkBrowser(owner);
        };
        current();
        await this.#revoke();
        current();
        await owner.client.health(
          this.#browserScope(owner, {
            signal: AbortSignal.any([this.#manual.signal, AbortSignal.timeout(5000)]),
            check: current,
          }),
        );
        current();
        if (!owner.manualPermit) throw new ScreenControlError();
      },
    };
  }

  // Called by the daemon before a new brain can sample or acquire a tool lease. A retired
  // generation leaves this owner held; its replacement must obtain a fresh physical grant.
  async activate(raw: ScreenScope): Promise<ScreenSwitchData> {
    const scope = this.#scope(raw);
    if (this.#closed || this.#failed || this.#returning) throw new ScreenControlError();
    if (this.#held) return this.handback(scope);
    return this.#switch(this.#selection.screen, scope, true);
  }

  // `user` false: a brain's retirement, which leaves the computer to the user when no other task
  // is at work on the browser and otherwise only lets go of this task's own grant.
  takeOver(user = true): Promise<void> {
    if (this.#closed || this.#failed) return Promise.reject(new ScreenControlError());
    if (this.#holding && !this.#returning && (this.#userHeld || !user)) return this.#holding;
    this.#held = true;
    this.#userHeld ||= user;
    this.#userBrowser = false;
    this.#userReady = false;
    this.#manual.abort();
    this.#manual = new AbortController();
    this.#epoch++;
    const epoch = this.#epoch;
    this.#control.abort();
    this.#actions.abort();
    const completion = Promise.withResolvers<void>();
    this.#holding = completion.promise;
    // As at a screen switch, a browser that can't confirm the hand-back is stopped on its own;
    // only one that can't be stopped either contains the session and its computer.
    const handBack = () => this.#revoke().catch(() => this.#retireBrowser());
    const waits = [
      this.#safe(() => this.deps.fenceRecording()),
      handBack(),
      this.#tail,
      ...this.#active,
    ];
    void Promise.allSettled(waits)
      .then(async (results) => {
        if (results.some((result) => result.status === "rejected")) {
          await this.#fail();
          throw new ScreenControlError();
        }
        // A browser preparation already in flight may have returned while the queue drained.
        await handBack();
        if (epoch === this.#epoch && !this.#closed && !this.#failed) {
          this.#userReady = true;
          this.#regrant();
        }
      })
      .then(completion.resolve, completion.reject);
    return this.#holding;
  }

  async handback(raw: ScreenScope): Promise<ScreenSwitchData> {
    const scope = this.#scope(raw);
    if (!this.#held || this.#returning || this.#closed || this.#failed)
      throw new ScreenControlError();
    this.#returning = true;
    this.#userBrowser = false;
    this.#userReady = false;
    this.#manual.abort();
    const epoch = this.#epoch;
    try {
      await this.#holding;
      scope.check();
      if (epoch !== this.#epoch || this.#closed || this.#failed) throw new ScreenControlError();
      this.#control = new AbortController();
      const result = await this.#switch(this.#selection.screen, scope, true);
      if (epoch !== this.#epoch || this.#closed || this.#failed) throw new ScreenControlError();
      this.#held = false;
      this.#userHeld = false;
      this.#holding = undefined;
      return result;
    } catch (error) {
      // A cancelled hand-back must not leave the user's input signal aborted.
      // Re-establish physical user ownership before reopening manual admission.
      this.#returning = false;
      if (epoch === this.#epoch && !this.#closed && !this.#failed) {
        this.#holding = undefined;
        await this.takeOver(this.#userHeld);
      }
      throw error;
    } finally {
      this.#returning = false;
    }
  }

  // Only a drained session may finish normally. Stop can still upgrade this cleanup
  // to containment, including while the browser's physical retirement is pending.
  finish(): Promise<void> {
    if (this.#closing) {
      if (this.#finishing) return this.#closing;
      return Promise.reject(new ScreenControlError());
    }
    if (
      this.#failed ||
      this.#pending ||
      this.#active.size ||
      this.#returning ||
      (this.#ownerGeneration !== undefined && !this.#held)
    )
      return Promise.reject(new ScreenControlError());
    return this.#shutdown(false);
  }

  // Private answers must never enter the raw video recording, including visible
  // verification-code boxes. Resume only after a fresh read proves no filled secret remains.
  async privateInput<T>(lease: ScreenLease, work: () => Promise<T>): Promise<T> {
    lease.check();
    const selection = lease.selection;
    const access = this.browserAccess(lease);
    await this.deps.fenceRecording();
    lease.check();
    const resume = async () => {
      let clear = false;
      try {
        lease.check();
        await access.client.read(access.permit, access.tabId, { maxChars: 500 }, lease);
        lease.check();
        clear = true;
      } catch {
        // A filled code, changing document, or Stop keeps recording fenced.
      }
      if (clear) {
        try {
          await this.deps.attachRecording(selection, lease);
          lease.check();
        } catch (error) {
          if (!lease.signal.aborted) await this.#fail();
          throw error;
        }
      }
    };
    try {
      return await work();
    } finally {
      await resume();
    }
  }

  // Normal task cancellation fences new input, drains existing leases and revokes
  // this task's browser grant. The computer and its signed-in browser outlive it.
  cancel(): Promise<void> {
    if (this.#closing) return this.#closing;
    return this.#shutdown(false);
  }

  close(): Promise<void> {
    if (!this.#closing) return this.#shutdown(true);
    if (!this.#finishing) return this.#closing;
    this.#finishing = false;
    const previous = this.#closing;
    const completion = Promise.withResolvers<void>();
    this.#closing = completion.promise;
    // Publish the upgraded receipt before fenceSession can reenter close().
    const containment = this.#fail();
    void Promise.allSettled([previous, containment])
      .then((results) => {
        if (results.some((result) => result.status === "rejected")) throw new ScreenControlError();
      })
      .then(completion.resolve, completion.reject);
    return this.#closing;
  }

  #shutdown(contain: boolean): Promise<void> {
    const completion = Promise.withResolvers<void>();
    this.#closing = completion.promise;
    this.#finishing = !contain;
    this.#closed = true;
    this.#userReady = false;
    this.#epoch++;
    this.#manual.abort();
    this.#control.abort();
    this.#actions.abort();
    const cleanup = contain
      ? this.#fail()
      : Promise.allSettled(
          [
            this.#safe(() => this.#retireDownloads()),
            this.#safe(() => this.deps.fenceRecording()),
          ].map((work) =>
            work.catch((error: unknown) => {
              // Contain promptly without letting one failure abandon another drain.
              void this.#fail().catch(() => {});
              throw error;
            }),
          ),
        ).then((results) => {
          if (results.some((result) => result.status === "rejected"))
            throw new ScreenControlError();
        });
    void Promise.allSettled([
      cleanup,
      this.#tail,
      ...this.#active,
      ...(this.#holding ? [this.#holding] : []),
    ])
      .then(async (results) => {
        // No grant of this session outlives its terminal receipt. A finished task hands the
        // browser back to the user and leaves it running for the next one (a browser that has
        // since restarted holds no grant of this session); containment, including a Stop that
        // arrives while the task finishes, stops it.
        const owner = this.#browser;
        const stop = () => this.deps.browser.stop(this.#key);
        try {
          if (
            !contain &&
            owner &&
            this.deps.browser.endpoints(this.#key)?.instance === owner.endpoint.instance
          )
            await this.#revoke(true).catch(stop);
          if (contain || this.#failed) await stop();
        } catch {
          throw new ScreenControlError();
        }
        this.#browser?.client.close();
        this.deps.lane?.release();
        if (results.some((result) => result.status === "rejected")) throw new ScreenControlError();
      })
      .catch(async () => {
        this.deps.lane?.release();
        // A successful task must not hide unconfirmed recording/browser cleanup.
        await this.#fail().catch(() => {});
        throw new ScreenControlError();
      })
      .then(completion.resolve, completion.reject);
    return this.#closing;
  }

  #switch(
    screen: ScreenName,
    scope: ScreenScope,
    handback: boolean,
    { forUser = false, restart = false, daemon = false } = {},
  ): Promise<ScreenSwitchData> {
    const epoch = this.#epoch;
    const guard = () => {
      scope.check();
      if (
        this.#closed ||
        this.#failed ||
        epoch !== this.#epoch ||
        (this.#held && !handback) ||
        this.#control.signal.aborted
      )
        throw new ScreenControlError();
    };
    guard();
    this.#pending++;
    this.#actions.abort();
    const downloadsRetired = this.#retireDownloads();
    const control = this.#control.signal;
    const operationScope: BrowserScope = {
      signal: AbortSignal.any([scope.signal, control]),
      check: guard,
    };
    let granted = false;
    let integrity = false;
    let recorded = false;
    let published = false;
    const operation = this.#tail
      .then(async () => {
        let turn: { release(): void } | undefined;
        try {
          guard();
          if (screen === "browser") {
            await this.#claim(operationScope);
            // A grant and a window change what the browser's one display shows.
            turn = await this.deps.turn?.(operationScope.signal, this.#key);
          }
          guard();
          await Promise.all([...this.#active, downloadsRetired]);
          guard();
          await this.#revoke().catch((error: unknown) => {
            if (handback) throw error;
            return this.#retireBrowser();
          });
          guard();
          let cellId = this.deps.parentCellId;
          let geometry = this.#desktopGeometry;
          if (screen === "browser") {
            const owner = await this.#prepare(operationScope, restart);
            guard();
            // A fresh physical user receipt owns profile restoration. Reconnect before
            // granting the agent anything, attaching recording, or inspecting the page.
            const health = await owner.client.health(this.#browserScope(owner, operationScope));
            guard();
            if (health.signIn?.mode === "signin" || health.signIn?.changing) {
              // Sign-in mode has no agent grant to disturb: this asks for the user's receipt that
              // restores the managed browser, if the task holds none.
              if (!owner.userPermit)
                await this.#userReceipt(owner, this.#browserScope(owner, operationScope));
              if (!owner.userPermit || !owner.client.signIn) throw new ScreenControlError();
              try {
                await owner.client.signIn(
                  owner.userPermit,
                  "standard",
                  this.#browserScope(owner, operationScope),
                );
              } catch (error) {
                guard();
                const current = await owner.client.health(
                  this.#browserScope(owner, operationScope),
                );
                if (
                  handback &&
                  current.holder === "user" &&
                  current.signIn?.mode === "signin" &&
                  !current.signIn.changing
                )
                  throw new SignInStillHeldError();
                throw error;
              }
              guard();
            }
            owner.manualPermit = undefined;
            owner.userPermit = undefined;
            const request = {
              ...this.#identity(owner),
              revision: this.#nextRevision(owner),
              requestId: ulid(),
              holder: "agent" as const,
              owner: { sessionId: scope.sessionId, generation: scope.generation },
            };
            const browserScope = this.#browserScope(owner, operationScope);
            granted = true;
            owner.granting = request.owner;
            await owner.client.control(request, browserScope);
            guard();
            owner.permit = Object.freeze({
              ...this.#identity(owner),
              revision: request.revision,
              requestId: request.requestId,
              owner: Object.freeze({ ...request.owner }),
            });
            await this.#enterWindow(owner, browserScope);
            guard();
            if (this.#freshTab) owner.tabId = await this.#openTab(owner, browserScope);
            owner.tabId = await this.#foreground(owner, browserScope);
            guard();
            cellId = owner.endpoint.browserCellId;
            // BrowserOrchestrator creates the separate display at its parent's scale.
            const scale = this.#desktopGeometry.scale;
            geometry = { w: 1280 * scale, h: 800 * scale, scale };
          } else {
            if (!this.deps.desktopReady()) throw new ScreenControlError();
            this.deps.coming?.("desktop", this.deps.parentCellId);
          }
          const result = ScreenSwitchData.parse({
            screen,
            cellId,
            geometry,
            revision: this.#selection.revision + 1,
            by: handback || forUser || daemon ? "daemon" : "agent",
          });
          const selection = Object.freeze({
            screen,
            cellId,
            geometry: Object.freeze({ ...result.geometry }),
            revision: result.revision,
          });
          integrity = true;
          recorded = true;
          await this.deps.attachRecording(selection, operationScope);
          integrity = false;
          guard();
          if (screen === "browser") {
            if (!this.#browser) throw new ScreenControlError();
            const owner = this.#browser;
            this.#checkBrowser(owner);
            if (!owner.permit || !owner.tabId) throw new ScreenControlError();
            // Recording attachment can await I/O. Confirm the same native foreground
            // again before publishing the selection or letting agent work resume.
            await owner.client.clock(
              owner.permit,
              owner.tabId,
              this.#browserScope(owner, operationScope),
            );
            guard();
            // A page opened for the user is no task's: its hold has no brain to collect downloads
            // for, and the user's own collection starts at the takeover that follows.
            if (!forUser)
              await this.#startDownloads(
                owner,
                {
                  holder: "agent",
                  sessionId: this.deps.sessionId,
                  permit: owner.permit,
                },
                operationScope,
              );
            guard();
          } else if (!this.deps.desktopReady()) throw new ScreenControlError();
          integrity = true;
          published = true;
          this.deps.publish(result);
          guard();
          this.#selection = selection;
          this.#ownerGeneration = scope.generation;
          if (screen === "desktop") this.deps.up?.("desktop");
          else this.#freshTab = false;
          return result;
        } catch (error) {
          if (error instanceof SignInStillHeldError) throw error;
          if (epoch !== this.#epoch || (this.#held && !handback) || this.#closed) {
            await this.#revoke().catch(() => this.#retireBrowser());
          } else if (screen === "browser" && !published) {
            // A web browser that fails, its recording included, costs dot the web browser, never
            // the task or the computer: no grant of it is left, and the session goes on recorded
            // on the desktop.
            if (granted || handback) await this.#revoke().catch(() => this.#retireBrowser());
            this.#reportBrowser(error);
            const desktop = await this.#onDesktop(scope, operationScope, handback, recorded);
            if (handback && desktop) return desktop;
            if (error instanceof BrowserCoveredError) throw new BrowserCoveredError(true);
            if (error instanceof BrowserBusyError) throw new BrowserBusyError(true);
            throw await this.#browserUnavailable();
          } else if (handback || integrity) {
            // An unrecorded screen, an unjournaled selection or a daemon handback that cannot
            // complete is uncertainty the session cannot continue past.
            await this.#fail();
          } else {
            // The agent asked for a screen that is unavailable. That is an ordinary tool
            // failure once no grant this call requested can still be live.
            if (granted) await this.#revoke().catch(() => this.#retireBrowser());
            throw new ScreenUnavailableError(
              screen,
              this.deps.browser.get(this.#key)?.state === "starting",
              this.deps.browser.problem?.(this.#key),
            );
          }
          throw new ScreenControlError();
        } finally {
          turn?.release();
        }
      })
      .finally(() => {
        this.#pending--;
      });
    this.#tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  // A browser the daemon reports as running failed this switch for a reason of its own; anything
  // else is described as the daemon sees it, and dot hears when it runs again.
  async #browserUnavailable(): Promise<ScreenUnavailableError> {
    const parent = this.#key;
    const status = await this.deps.browser.status?.(parent).catch(() => undefined);
    const unready = status?.state === "ready" ? undefined : status;
    if (unready) this.deps.browser.noteOutage?.(parent);
    return new ScreenUnavailableError(
      "browser",
      this.deps.browser.get(parent)?.state === "starting",
      unready?.problem ?? this.deps.browser.problem?.(parent),
      unready,
    );
  }

  #reportBrowser(error: unknown, what = "the web browser couldn't be shown"): void {
    this.deps.report?.(
      `${what}: ${
        error instanceof BrowserCoveredError
          ? "one of its own dialogs, bubbles or menus is over its page"
          : error instanceof BrowserBusyError
            ? "its page didn't answer in time"
            : error instanceof BrowserClientError ||
                error instanceof BrowserLifecycleError ||
                error instanceof ScreenControlError ||
                (error instanceof Error && error.name === "ScreenRecordingError")
              ? error.message
              : "unknown"
      }`,
    );
  }

  // Where the session goes on after the web browser failed it: the desktop, recorded, and
  // journaled when the selection moves there. A session that can't be put there is contained.
  async #onDesktop(
    scope: ScreenScope,
    operation: BrowserScope,
    handback: boolean,
    recorded: boolean,
  ): Promise<ScreenSwitchData | undefined> {
    const previous = this.#selection;
    try {
      operation.check();
      if (!this.deps.desktopReady()) throw new ScreenControlError();
      if (previous.screen === "desktop") {
        if (handback) throw new ScreenControlError();
        if (recorded) {
          await this.deps.attachRecording(previous, operation);
          operation.check();
        }
        return undefined;
      }
      const result = ScreenSwitchData.parse({
        screen: "desktop",
        cellId: this.deps.parentCellId,
        geometry: this.#desktopGeometry,
        revision: previous.revision + 1,
        by: "daemon",
      });
      const selection = Object.freeze({
        screen: "desktop" as const,
        cellId: this.deps.parentCellId,
        geometry: this.#desktopGeometry,
        revision: result.revision,
      });
      await this.deps.attachRecording(selection, operation);
      operation.check();
      if (!this.deps.desktopReady()) throw new ScreenControlError();
      this.deps.publish(result);
      this.#selection = selection;
      if (handback) this.#ownerGeneration = scope.generation;
      return result;
    } catch {
      await this.#fail();
      throw new ScreenControlError();
    }
  }

  // A browser that can't open the tab still shows the page in front, as before.
  async #openTab(owner: BrowserOwner, scope: BrowserScope): Promise<string | undefined> {
    if (!owner.permit || !owner.client.openTab) return undefined;
    try {
      return await owner.client.openTab(owner.permit, scope);
    } catch (error) {
      scope.check();
      if (!(error instanceof BrowserClientError)) throw error;
      this.deps.report?.(`a blank tab couldn't open in the web browser: ${error.message}`);
      return undefined;
    }
  }

  async #foreground(owner: BrowserOwner, outer: BrowserScope): Promise<string> {
    const expiry = new AbortController();
    const deadline = setTimeout(() => expiry.abort(), BROWSER_FOREGROUND_MS);
    const signal = AbortSignal.any([outer.signal, expiry.signal]);
    // What the last look at the tabs found over the page, if anything.
    let covered = false;
    const scope: BrowserScope = {
      signal,
      check: () => {
        outer.check();
        if (outer.signal.aborted) throw new ScreenControlError();
        if (expiry.signal.aborted)
          throw covered ? new BrowserCoveredError() : new BrowserBusyError();
      },
    };
    try {
      if (!owner.permit) throw new ScreenControlError();
      for (;;) {
        const listing = owner.client.ownTabs
          ? await owner.client.ownTabs(owner.permit, scope)
          : await owner.client.tabs(scope);
        scope.check();
        if (!listing.tabs.length) throw new ScreenControlError();
        let settling = listing.tabs.some((tab) => !tab.ready);
        let found = false;
        const ordered = [...listing.tabs]
          .filter((tab) => tab.ready)
          .sort((a, b) => Number(b.id === owner.tabId) - Number(a.id === owner.tabId));
        for (const tab of ordered) {
          try {
            // The admitted clock request first resolves BrowserGeometry: unique root
            // URL across all tabs, native active window, and two matching surfaces.
            // It neither activates a tab nor reads page content or secret fields.
            await owner.client.clock(owner.permit, tab.id, scope);
            scope.check();
            return tab.id;
          } catch (error) {
            scope.check();
            if (!(error instanceof BrowserClientError)) throw error;
            // A background tab fails geometry admission with HTTP 409 (refused), not
            // 503 (unavailable). Continue to the visible popup. Only this read-only
            // probe is retried; input keeps its original tab and is never replayed.
            // A surface of the browser's own may close by itself, as a menu does: looked for again
            // like a page that is settling, and named if it is still there when the time is up.
            if (error.code === "covered") found = true;
            if (["refused", "restarting", "covered"].includes(error.code)) settling = true;
            else if (error.code !== "unavailable") throw error;
          }
        }
        covered = found;
        if (!settling) throw new ScreenControlError();
        await sleep(150, undefined, { signal });
        scope.check();
      }
    } catch (error) {
      // A request that got no answer within its own bound, like the search as a whole, was kept
      // waiting by the page; one whose screen ended hears that instead.
      scope.check();
      throw error instanceof BrowserClientError && error.code === "aborted"
        ? covered
          ? new BrowserCoveredError()
          : new BrowserBusyError()
        : error;
    } finally {
      clearTimeout(deadline);
    }
  }

  async #prepare(scope: BrowserScope, restart = false): Promise<BrowserOwner> {
    await this.#claim(scope);
    if (restart && performance.now() - this.#restartRequested >= BROWSER_RESTART_REQUEST_MS) {
      this.#restartRequested = performance.now();
      const why = await this.deps.browser.failure?.(this.#key).catch(() => undefined);
      scope.check();
      this.deps.report?.(`dot restarted the web browser${why ? `: ${why}` : ""}`);
      // It is told what that costs in the tool's own reply.
      this.#windowTabs = new Set();
      this.deps.browser.noteProblem?.(
        this.#key,
        `dot restarted the web browser${why ? ` (${why})` : ""}.`,
      );
      this.#browser?.client.close();
      this.#browser = undefined;
      await this.deps.browser.stop(this.#key);
      scope.check();
    }
    let stopped = false;
    for (let waits = 0; ; ) {
      const endpoint = await this.deps.browser.start(this.#key);
      if (
        endpoint.parentCellId !== this.deps.parentCellId ||
        (endpoint.slot ?? endpoint.parentCellId) !== this.#key ||
        endpoint.browserCellId === endpoint.parentCellId
      )
        throw new ScreenControlError();
      if (!this.#browser || this.#browser.endpoint.instance !== endpoint.instance) {
        this.#browser?.client.close();
        this.#browser = {
          endpoint: structuredClone(endpoint),
          client: this.deps.client?.(endpoint) ?? new BrowserClient(endpoint),
          revision: 0,
        };
      }
      scope.check();
      const owner = this.#browser;
      try {
        await owner.client.health(this.#browserScope(owner, scope));
        scope.check();
        return owner;
      } catch (error) {
        scope.check();
        // A browser restarting its Chromium in place is waited for; one that no longer answers as
        // ready is started again, once.
        const answer = await this.deps.browser.health?.(this.#key);
        scope.check();
        if (answer === "restarting" && waits++ < RESTART_WAITS) {
          await sleep(RESTART_WAIT_MS, undefined, { signal: scope.signal });
          scope.check();
          continue;
        }
        if (stopped || (answer !== "unready" && answer !== "silent" && answer !== "restarting"))
          throw error;
        stopped = true;
        const why = await this.deps.browser.failure?.(this.#key).catch(() => undefined);
        scope.check();
        this.deps.report?.(
          `the web browser stopped working; starting it again${why ? `: ${why}` : ""}`,
        );
        this.deps.browser.noteProblem?.(
          this.#key,
          `The web browser stopped working${why ? ` (${why})` : ""}; localDot started it again.`,
        );
        owner.client.close();
        if (this.#browser === owner) this.#browser = undefined;
        // Only the browser that failed is stopped, never one started since.
        if (this.deps.browser.endpoints(this.#key)?.instance === owner.endpoint.instance)
          await this.deps.browser.stop(this.#key);
        scope.check();
      }
    }
  }
  // Ends what this task holds of the browser. Only the user's own control reaches further, and
  // takes the whole browser from every task; a task's release leaves the others at work. `over`
  // says the task is done with its window as well.
  #revoke(over = false): Promise<void> {
    const owner = this.#browser;
    if (!owner) return this.#retireDownloads();
    if (owner.revoking)
      return over ? owner.revoking.then(() => this.#revoke(true)) : owner.revoking;
    const downloadsRetired = this.#retireDownloads();
    const granted = owner.permit?.owner ?? owner.granting;
    owner.permit = undefined;
    owner.granting = undefined;
    owner.tabId = undefined;
    owner.manualPermit = undefined;
    owner.userPermit = undefined;
    const toUser = this.#held && this.#userOnBrowser && (!over || this.#userHeld);
    if (!toUser && !granted && !over) return downloadsRetired;
    const scope = this.#browserScope(owner, { signal: AbortSignal.timeout(5000), check: () => {} });
    const identity = () => ({
      ...this.#identity(owner),
      revision: this.#nextRevision(owner),
      requestId: ulid(),
    });
    const release = (keep: boolean) =>
      owner.client.control(
        {
          ...identity(),
          holder: "release",
          owner: granted ?? {
            sessionId: this.deps.sessionId,
            generation: this.#ownerGeneration ?? 1,
          },
          ...(keep ? { keep: true } : {}),
        },
        scope,
      );
    const pending = this.#safe(async () => {
      await downloadsRetired;
      if (!toUser) {
        await release(!over);
        return;
      }
      const request = identity();
      const reply = await owner.client.control(
        {
          ...request,
          holder: "user",
          front: this.deps.sessionId,
          ...(this.#userHeld ? {} : { alone: true }),
        },
        scope,
      );
      // The user's receipt of a task that is over dies with it: the window goes free as well.
      if (over) {
        await release(false);
        return;
      }
      if (reply.holder !== "user") return;
      const permit = Object.freeze(request);
      if (this.#browser === owner && owner.revision === request.revision) owner.userPermit = permit;
      if (
        this.#browser === owner &&
        owner.revision === request.revision &&
        this.#held &&
        !this.#returning &&
        !this.#closed &&
        !this.#failed
      ) {
        owner.manualPermit = permit;
        const health = await owner.client.health(scope);
        if (this.#userOnBrowser && health.signIn?.mode !== "signin" && !health.signIn?.changing) {
          await this.#startDownloads(
            owner,
            {
              holder: "user",
              sessionId: this.deps.sessionId,
              permit: owner.manualPermit,
            },
            scope,
          );
        }
      }
    }).finally(() => {
      if (owner.revoking === pending) owner.revoking = undefined;
    });
    owner.revoking = pending;
    return pending;
  }

  async #userReceipt(owner: BrowserOwner, scope: BrowserScope): Promise<void> {
    const identity = {
      ...this.#identity(owner),
      revision: this.#nextRevision(owner),
      requestId: ulid(),
    };
    await owner.client.control({ ...identity, holder: "user" }, scope);
    owner.userPermit = Object.freeze(identity);
  }

  // The task's window comes forward, a new one if it has none. A window it lost while it waited is
  // something it should hear. The task before it may still be draining an action it was stopped in.
  async #enterWindow(owner: BrowserOwner, scope: BrowserScope): Promise<void> {
    if (!owner.permit || !owner.client.enterWindow) return;
    this.deps.coming?.("browser", this.#key);
    for (let waits = 0; ; waits++) {
      try {
        const { tabs } = await owner.client.enterWindow(
          owner.permit,
          {
            ...(this.deps.continues ? { continues: this.deps.continues } : {}),
            ...(this.#freshTab ? { fresh: true } : {}),
          },
          scope,
        );
        if (this.#windowTabs.size && !tabs.some((tab) => this.#windowTabs.has(tab.id)))
          this.deps.remind?.(BROWSER_WINDOW_LOST);
        this.#windowTabs = new Set(tabs.map((tab) => tab.id));
        break;
      } catch (error) {
        scope.check();
        if (!(error instanceof BrowserClientError) || error.code !== "busy" || waits >= BUSY_WAITS)
          throw error;
        await sleep(BUSY_WAIT_MS, undefined, { signal: scope.signal });
        scope.check();
      }
    }
    this.deps.up?.("browser");
  }

  // The task's turn on the computer is starting: on the web browser, its window comes to the front.
  // A browser restarting in place is waited for. A grant the user's control ended, or a browser
  // that was started anew, is taken again on this turn; the task hears only if its page went.
  async enterTurn(raw: ScreenScope): Promise<void> {
    const scope = this.#scope(raw);
    if (this.#selection.screen !== "browser" || this.#held || this.#closed || this.#failed) return;
    await this.#tail;
    scope.check();
    if (this.#selection.screen !== "browser" || this.#held || this.#closed || this.#failed) return;
    const owner = this.#browser;
    if (owner?.permit && this.#sameBrowser(owner)) {
      const browserScope = this.#browserScope(owner, scope);
      for (let waits = 0; ; waits++) {
        try {
          await this.#enterWindow(owner, browserScope);
          scope.check();
          return;
        } catch (error) {
          scope.check();
          if (!(error instanceof BrowserClientError) || error.code !== "restarting") break;
          if (waits >= RESTART_WAITS) break;
          await sleep(RESTART_WAIT_MS, undefined, { signal: scope.signal });
          scope.check();
        }
      }
    }
    // A browser started anew holds no grant of this task's to give back.
    if (owner && !this.#sameBrowser(owner)) {
      owner.client.close();
      this.#browser = undefined;
    }
    await this.#switch("browser", scope, true);
  }

  #sameBrowser(owner: BrowserOwner): boolean {
    try {
      this.#checkBrowser(owner);
      return true;
    } catch {
      return false;
    }
  }

  // While the user holds the web browser's screen, a browser that stopped or started again holds
  // no grant of theirs: the running one is prepared and handed to them, so their input reaches it.
  #regrant(): void {
    const owner = this.#browser;
    if (
      this.#regranting ||
      !this.#held ||
      !this.#userReady ||
      this.#returning ||
      this.#pending ||
      this.#closed ||
      this.#failed ||
      !this.#userOnBrowser ||
      !this.deps.desktopReady() ||
      (owner?.manualPermit &&
        this.deps.browser.endpoints(this.#key)?.instance === owner.endpoint.instance)
    )
      return;
    const epoch = this.#epoch;
    const selection = this.#selection;
    const scope: BrowserScope = {
      signal: this.#manual.signal,
      check: () => {
        if (
          epoch !== this.#epoch ||
          selection !== this.#selection ||
          !this.#held ||
          this.#returning ||
          this.#closed ||
          this.#failed
        )
          throw new ScreenControlError();
      },
    };
    const work = this.#prepare(scope)
      .then(() => {
        scope.check();
        return this.#revoke();
      })
      .catch(() => {
        if (!scope.signal.aborted) this.deps.report?.("the web browser couldn't be handed back");
      });
    this.#regranting = work;
    this.#active.add(work);
    void work.finally(() => {
      this.#active.delete(work);
      if (this.#regranting === work) this.#regranting = undefined;
    });
  }

  // An unconfirmed revocation leaves the browser's holder unknown. Only its confirmed
  // physical stop proves that no agent grant survives; otherwise the session is contained.
  async #retireBrowser(): Promise<void> {
    const owner = this.#browser;
    try {
      await this.deps.browser.stop(this.#key);
    } catch {
      await this.#fail();
      throw new ScreenControlError();
    }
    owner?.client.close();
    if (this.#browser === owner) this.#browser = undefined;
  }

  async #startDownloads(
    owner: BrowserOwner,
    binding: BrowserDownloadBinding,
    startup: BrowserScope,
  ): Promise<void> {
    if (!this.deps.downloads) return;
    startup.check();
    const epoch = this.#downloadEpoch;
    const signal = binding.holder === "agent" ? this.#control.signal : this.#manual.signal;
    const check = () => {
      signal.throwIfAborted();
      if (
        this.#closed ||
        this.#failed ||
        epoch !== this.#downloadEpoch ||
        this.#browser !== owner ||
        !this.deps.desktopReady() ||
        binding.sessionId !== this.deps.sessionId ||
        (binding.holder === "agent"
          ? owner.permit !== binding.permit
          : owner.manualPermit !== binding.permit || !this.#held || this.#returning)
      )
        throw new ScreenControlError();
      this.#checkBrowser(owner);
    };
    check();
    const collection = this.deps.downloads(owner.endpoint, binding, { signal, check });
    this.#downloads = collection;
    const cancelled = () => collection.stop();
    startup.signal.addEventListener("abort", cancelled, { once: true });
    if (startup.signal.aborted) cancelled();
    try {
      await collection.ready;
      startup.check();
      check();
    } finally {
      startup.signal.removeEventListener("abort", cancelled);
    }
  }

  async #retireDownloads(): Promise<void> {
    this.#downloadEpoch++;
    const collection = this.#downloads;
    this.#downloads = undefined;
    if (collection) {
      collection.stop();
      const settled = collection.settled;
      this.#downloadRetiring.add(settled);
      void settled.then(
        () => this.#downloadRetiring.delete(settled),
        () => {},
      );
    }
    return Promise.all(this.#downloadRetiring).then(() => {});
  }
  #checkTarget(): void {
    if (this.#selection.screen === "desktop") {
      if (!this.deps.desktopReady()) throw new ScreenControlError();
    } else {
      if (!this.#browser?.permit) throw new ScreenControlError();
      this.#checkBrowser(this.#browser);
    }
  }
  #checkBrowser(owner: BrowserOwner): void {
    const current = this.deps.browser.endpoints(this.#key);
    if (
      current?.instance !== owner.endpoint.instance ||
      current.browserCellId !== owner.endpoint.browserCellId ||
      current.parentCellId !== owner.endpoint.parentCellId ||
      current.browserd.token !== owner.endpoint.browserd.token ||
      current.browserd.baseUrl !== owner.endpoint.browserd.baseUrl
    )
      throw new ScreenControlError();
  }
  #browserScope(owner: BrowserOwner, scope: BrowserScope): BrowserScope {
    return {
      signal: scope.signal,
      check: () => {
        scope.check();
        this.#checkBrowser(owner);
      },
    };
  }
  #nextRevision(owner: BrowserOwner): number {
    owner.revision = this.deps.revision?.(owner.endpoint.instance) ?? owner.revision + 1;
    return owner.revision;
  }
  #identity(owner: BrowserOwner) {
    const { parentCellId, browserCellId, instance } = owner.endpoint;
    return { parentCellId, browserCellId, instance };
  }
  #scope(raw: ScreenScope): ScreenScope {
    const { sessionId, generation, signal } = raw;
    const original = raw.check.bind(raw);
    const check = () => {
      if (
        sessionId !== this.deps.sessionId ||
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        signal.aborted
      )
        throw new ScreenControlError();
      try {
        original();
      } catch {
        throw new ScreenControlError();
      }
    };
    check();
    return Object.freeze({ sessionId, generation, signal, check });
  }
  #safe(work: () => Promise<void>): Promise<void> {
    try {
      return work();
    } catch {
      return Promise.reject(new ScreenControlError());
    }
  }
  #fail(): Promise<void> {
    if (this.#containment) return this.#containment;
    const completion = Promise.withResolvers<void>();
    this.#containment = completion.promise;
    this.#failed = true;
    this.#userReady = false;
    this.#manual.abort();
    this.#held = true;
    this.#userHeld = false;
    this.#epoch++;
    this.#control.abort();
    this.#actions.abort();
    // Neither a failed recording fence nor a failed session observer may skip containment.
    try {
      this.deps.fenceSession();
    } catch {
      /* Physical containment remains mandatory. */
    }
    void Promise.allSettled([
      this.#safe(() => this.#retireDownloads()),
      this.#safe(() => this.deps.fenceRecording()),
      this.#safe(() => this.deps.contain()),
    ])
      .then((results) => {
        this.#browser?.client.close();
        if (results.some((result) => result.status === "rejected")) throw new ScreenControlError();
      })
      .then(completion.resolve, completion.reject);
    return this.#containment;
  }
}
