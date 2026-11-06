import { setTimeout as sleep } from "node:timers/promises";
import {
  BrowserActionPermit,
  BrowserWindowEntry,
  type BrowserWindowReply,
} from "../../../../packages/protocol/src/browser-control.ts";
import type { BrowserControl } from "./control.ts";
import type { BrowserNative } from "./native.ts";
import type { BrowserSecrets } from "./secrets.ts";
import type { BrowserPage, BrowserTargets } from "./targets.ts";

// How many windows of finished tasks stay open for the next task and for a conversation that goes
// on: each holds its page's memory and about 100 MiB of its own.
export const BROWSER_KEPT_FREE_WINDOWS = 2;
const WINDOW_APPEARS_MS = 3000;
const WINDOW_POLL_MS = 50;
// After a raise Chromium's accessibility is busy with the focus change for a moment.
const SURFACE_SETTLES_MS = 3000;
const SURFACE_RETRY_MS = 100;

export class BrowserWindowError extends Error {
  constructor(readonly reason: "unavailable" | "stale") {
    super(`Browser window refused: ${reason}`);
  }
}

interface TaskWindow {
  readonly id: number;
  // Its window on the display; Chromium's window ids name no X window.
  xid?: number;
  owner?: string;
  // The task that last had it.
  left?: string;
  // Newest use last: what a task's next turn brings forward.
  used: number;
}

export interface BrowserWindowsDeps {
  control: Pick<BrowserControl, "admit">;
  targets: Pick<
    BrowserTargets,
    "pages" | "openWindow" | "settleNewWindow" | "activate" | "closeTab"
  >;
  native: Pick<BrowserNative, "command">;
  secrets: Pick<BrowserSecrets, "secretPages" | "reload">;
}

// One browser, one window per task. Each permit is good for its task's windows only: the one the
// task was given, and those its pages open. The display shows one window at a time, so a task's
// turn raises its window and checks it is the active one before anything is read or pressed.
export class BrowserWindows {
  readonly #windows = new Map<number, TaskWindow>();
  readonly #pointers = new Map<string, { x: number; y: number }>();
  #front?: string;
  #opening?: string;
  #uses = 0;

  constructor(private readonly deps: BrowserWindowsDeps) {}

  // The windows as they are now: a window nobody has claimed is its opener's task's, or that of
  // the task on screen if no page opened it; before any task, nobody's.
  #sync(): readonly BrowserPage[] {
    const pages = this.deps.targets.pages();
    const live = new Set(pages.flatMap((page) => page.windowId ?? []));
    for (const id of this.#windows.keys()) if (!live.has(id)) this.#windows.delete(id);
    for (const page of pages) {
      if (page.windowId === undefined || this.#windows.has(page.windowId)) continue;
      const opener = page.opener ? pages.find((other) => other.id === page.opener) : undefined;
      const parent = opener?.windowId ? this.#windows.get(opener.windowId) : undefined;
      const owner = parent?.owner ?? (parent ? undefined : (this.#opening ?? this.#front));
      this.#windows.set(page.windowId, {
        id: page.windowId,
        used: ++this.#uses,
        ...(owner ? { owner } : {}),
      });
    }
    return pages;
  }

  ownerOf(tabId: string): string | undefined {
    const page = this.#sync().find((candidate) => candidate.id === tabId);
    return page?.windowId === undefined ? undefined : this.#windows.get(page.windowId)?.owner;
  }

  owns(sessionId: string, tabId: string): boolean {
    return this.ownerOf(tabId) === sessionId;
  }

  // Another task has a window beside this tab's.
  othersAtWork(tabId: string): boolean {
    const owner = this.ownerOf(tabId);
    return [...this.#windows.values()].some((window) => window.owner && window.owner !== owner);
  }

  // A window on the display is the one Chromium means: what it was first seen as, and no other
  // window's. A popup's first look binds it, which is why only a task's own turn may look.
  bound(windowId: number, xid: number): boolean {
    this.#sync();
    const window = this.#windows.get(windowId);
    if (!window) return false;
    if (window.xid !== undefined) {
      if (window.xid === xid) window.used = ++this.#uses;
      return window.xid === xid;
    }
    if ([...this.#windows.values()].some((other) => other.xid === xid)) return false;
    window.xid = xid;
    window.used = ++this.#uses;
    return true;
  }

  // The task's tabs: nobody else's are for it to see.
  tabs(raw: unknown): BrowserWindowReply["tabs"] {
    const permit = BrowserActionPermit.parse(raw);
    const lease = this.deps.control.admit(permit);
    try {
      return this.#tabsOf(permit.owner.sessionId);
    } finally {
      lease.finish();
    }
  }

  // A tab of the task's newest window.
  anchor(sessionId: string): string | undefined {
    const pages = this.#sync();
    const window = this.#newest(sessionId);
    return window && pages.find((page) => page.windowId === window.id)?.id;
  }

  async enter(raw: unknown, signal: AbortSignal): Promise<BrowserWindowReply> {
    const { permit, continues, fresh } = BrowserWindowEntry.parse(raw);
    const sessionId = permit.owner.sessionId;
    const lease = this.deps.control.admit(permit);
    try {
      const scope = AbortSignal.any([signal, lease.signal]);
      this.#sync();
      let window = this.#newest(sessionId);
      let opened = false;
      if (!window) {
        const free = this.#free();
        const kept =
          free.findLast((other) => other.left === sessionId) ??
          (continues ? free.findLast((other) => other.left === continues) : undefined);
        const others = [...this.#windows.values()].some((other) => other.owner !== undefined);
        // A task that has been at work never lands on another task's page; a new one finds it
        // behind its blank tab, as it does alone.
        window = kept ?? (others && !fresh ? undefined : free.at(-1));
        if (window) {
          window.owner = sessionId;
          window.used = ++this.#uses;
          if (others && window.left !== sessionId) await this.#scrub(window, scope);
          delete window.left;
        } else {
          window = await this.#open(sessionId, scope);
          opened = true;
        }
        lease.check();
      }
      await this.#raise(window, sessionId, scope);
      lease.check();
      if (opened) {
        const tab = this.#sync().find((page) => page.windowId === window.id);
        if (tab) await this.deps.targets.settleNewWindow(tab.id);
        lease.check();
      }
      return { tabs: this.#tabsOf(sessionId), opened };
    } finally {
      lease.finish();
    }
  }

  #tabsOf(sessionId: string): BrowserWindowReply["tabs"] {
    return this.#sync()
      .filter(
        (page) =>
          page.windowId !== undefined && this.#windows.get(page.windowId)?.owner === sessionId,
      )
      .map(({ id, ready }) => ({ id, ready }));
  }

  // The user takes the browser in this task's window, after every action has drained.
  async front(sessionId: string, signal: AbortSignal): Promise<void> {
    this.#sync();
    const window = this.#newest(sessionId);
    if (window) await this.#raise(window, sessionId, signal);
  }

  // Sign-in mode relaunches the browser, whose restored windows nothing could tell apart: only the
  // window the user signs in with stays. The other tasks hear theirs went when they next act.
  async closeOthers(): Promise<void> {
    const pages = this.#sync();
    const kept = this.#front ? this.#newest(this.#front) : undefined;
    for (const window of [...this.#windows.values()]) {
      if (window === kept) continue;
      if (!kept && this.#windows.size <= 1) break;
      this.#windows.delete(window.id);
      for (const tab of pages.filter((page) => page.windowId === window.id))
        await this.deps.targets.closeTab(tab.id);
    }
  }

  // The task is over: its window waits for the next task, a few of them at most. A task that only
  // left for the desktop keeps its window.
  release(sessionId: string, keep: boolean): void {
    if (keep) return;
    this.#sync();
    this.#pointers.delete(sessionId);
    for (const window of this.#windows.values())
      if (window.owner === sessionId) {
        delete window.owner;
        window.left = sessionId;
      }
    void this.#trim().catch(() => {});
  }

  #newest(sessionId: string): TaskWindow | undefined {
    return [...this.#windows.values()]
      .filter((window) => window.owner === sessionId)
      .sort((first, second) => first.used - second.used)
      .at(-1);
  }

  #free(): TaskWindow[] {
    return [...this.#windows.values()]
      .filter((window) => !window.owner)
      .sort((first, second) => first.used - second.used);
  }

  async #trim(): Promise<void> {
    const free = this.#free();
    for (const window of free.slice(0, Math.max(0, free.length - BROWSER_KEPT_FREE_WINDOWS))) {
      if (this.#windows.size <= 1) return;
      const tabs = this.deps.targets.pages().filter((page) => page.windowId === window.id);
      this.#windows.delete(window.id);
      for (const tab of tabs) await this.deps.targets.closeTab(tab.id);
    }
  }

  // A finished task may have left a filled secret field in the window another task now takes.
  async #scrub(window: TaskWindow, signal: AbortSignal): Promise<void> {
    const tabs = this.deps.targets
      .pages()
      .filter((page) => page.windowId === window.id)
      .map((page) => page.id);
    for (const page of await this.deps.secrets.secretPages(signal, tabs))
      await this.deps.secrets.reload(page, signal);
  }

  // A new window and its place on the display: the window that was not there before.
  async #open(sessionId: string, signal: AbortSignal): Promise<TaskWindow> {
    const before = new Set(
      (await this.deps.native.command("windows", {}, signal)).windows.map((w) => w.id),
    );
    this.#opening = sessionId;
    let tabId: string;
    try {
      tabId = await this.deps.targets.openWindow(signal);
    } finally {
      this.#opening = undefined;
    }
    const pages = this.#sync();
    const windowId = pages.find((page) => page.id === tabId)?.windowId;
    const window = windowId === undefined ? undefined : this.#windows.get(windowId);
    if (!window) throw new BrowserWindowError("unavailable");
    window.owner = sessionId;
    window.used = ++this.#uses;
    for (const deadline = performance.now() + WINDOW_APPEARS_MS; ; ) {
      const { windows } = await this.deps.native.command("windows", {}, signal);
      const known = new Set([...this.#windows.values()].map((other) => other.xid));
      const fresh = windows.filter((w) => !before.has(w.id) && !known.has(w.id));
      // Another task's page may open a window at the same moment: only the active one is sure.
      const found = fresh.length === 1 ? fresh[0] : fresh.find((w) => w.active);
      if (found) {
        window.xid = found.id;
        return window;
      }
      if (performance.now() >= deadline) throw new BrowserWindowError("unavailable");
      await sleep(WINDOW_POLL_MS, undefined, { signal });
    }
  }

  // A window not yet seen on the display: only one left unaccounted for, or the one Chromium
  // brings forward.
  async #place(window: TaskWindow, signal: AbortSignal): Promise<number> {
    const known = new Set([...this.#windows.values()].map((other) => other.xid));
    const { windows } = await this.deps.native.command("windows", {}, signal);
    const unaccounted = windows.filter((w) => !known.has(w.id));
    if (unaccounted.length === 1 && unaccounted[0]) return unaccounted[0].id;
    const tab = this.deps.targets.pages().find((page) => page.windowId === window.id);
    if (!tab) throw new BrowserWindowError("stale");
    await this.deps.targets.activate(tab.id);
    for (const deadline = performance.now() + WINDOW_APPEARS_MS; ; ) {
      const { windows: now } = await this.deps.native.command("windows", {}, signal);
      const active = now.find((w) => w.active);
      if (active && !known.has(active.id)) return active.id;
      if (performance.now() >= deadline) throw new BrowserWindowError("unavailable");
      await sleep(WINDOW_POLL_MS, undefined, { signal });
    }
  }

  // Nothing moves for a task that was on screen with nothing beside it. Otherwise copied text stays
  // behind with the task that copied it, the pointer comes back to where this task left it (a
  // hover keeps its menu), and the window comes forward.
  async #raise(window: TaskWindow, sessionId: string, signal: AbortSignal): Promise<void> {
    const previous = this.#front;
    if (this.#windows.size === 1 && (!previous || previous === sessionId)) {
      this.#front = sessionId;
      return;
    }
    const native = this.deps.native;
    const changing = previous !== sessionId;
    if (changing) {
      if (previous) {
        const { x, y } = await native.command("pointer", {}, signal);
        this.#pointers.set(previous, { x, y });
      }
      await native.command("clearSelections", {}, signal);
    }
    window.xid ??= await this.#place(window, signal);
    const { windows } = await native.command("windows", {}, signal);
    if (!windows.some((w) => w.id === window.xid)) {
      delete window.xid;
      window.xid = await this.#place(window, signal);
    }
    const xid = window.xid;
    // Set before it moves: a page opening a window as this one comes up is this task's.
    this.#front = sessionId;
    if (windows.find((w) => w.active)?.id !== xid) {
      const reply = await native.command("activate", { window: xid }, signal);
      if (reply.active !== xid) throw new BrowserWindowError("unavailable");
      for (const deadline = performance.now() + SURFACE_SETTLES_MS; ; ) {
        const surface = await native.command("surface", { window: xid }, signal);
        if (surface.page || performance.now() >= deadline) break;
        await sleep(SURFACE_RETRY_MS, undefined, { signal });
      }
    }
    if (changing) {
      const pointer = this.#pointers.get(sessionId);
      if (pointer) await native.command("move", pointer, signal);
    }
  }
}
