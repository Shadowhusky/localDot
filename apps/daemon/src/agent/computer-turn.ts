import type { Rect, WindowsRequest, WindowsResult } from "@localdot/protocol";
import type { ComputerGrant } from "../gateway/computer-lease.ts";
import type { LiveSessions } from "../gateway/live.ts";
import { hiddenParts, WindowOwners, type WindowsSnapshot } from "../gateway/window-owners.ts";

// How long reading the windows may hold up an action; a computer that can't say goes on unraised.
const WINDOWS_MS = 2000;
const RAISES = 2;

export type ReadWindows = (request: WindowsRequest, signal: AbortSignal) => Promise<WindowsResult>;

// One task's hold on its computer: a single action, or the user's control on its behalf.
export interface ComputerTurn {
  readonly sessionId: string;
  // The window belongs to another task at work on this computer.
  foreign(windowId: number | null | undefined): boolean;
  // What of the screen the task may not see, in screen pixels: the parts other tasks' windows
  // show, and windows that appeared too late to tell whose they are. `shown` is the stack a
  // capture was taken with.
  hidden(shown?: readonly { id: number; frame: Rect }[]): Promise<Rect[]>;
  // Others use the computer while the task waits (an approval, a judge); `resume` takes it back
  // and brings the task's window forward again before anything is read or done.
  yielding<T>(work: (resume: () => Promise<void>) => Promise<T>): Promise<T>;
  release(): Promise<void>;
}

export interface ComputerTurnsDeps {
  live: Pick<LiveSessions, "lease" | "cellOf" | "sessionsOn">;
  // The computer's window list; undefined when it has none to give (an older desktop).
  windows(cellId: string): ReadWindows | undefined;
  // A task on the web browser has its window brought forward there instead.
  browser?(sessionId: string): { enter(signal: AbortSignal): Promise<void> } | undefined;
  // Whose work the screens show, for the recordings: a turn on the desktop, or the user's control,
  // which may reach either screen.
  screens?: {
    coming(cellId: string, sessionId: string): void;
    up(sessionId: string): void;
    forUser(cellId: string, sessionId: string): void;
  };
}

// Every task acts on the computer in turns. A turn brings the task's own window forward and checks
// it is in front; what appeared during the turn is the task's.
export class ComputerTurns {
  readonly #owners = new Map<string, WindowOwners>();

  constructor(private readonly deps: ComputerTurnsDeps) {}

  owners(cellId: string): WindowOwners {
    let owners = this.#owners.get(cellId);
    if (!owners) {
      owners = new WindowOwners((id) => this.deps.live.cellOf(id) === cellId);
      this.#owners.set(cellId, owners);
    }
    return owners;
  }

  // Another task is acting on the computer: a turn taken now waits for it.
  busy(sessionId: string, cellId: string): boolean {
    const holder = this.deps.live.lease(cellId).holder;
    return holder !== undefined && holder !== sessionId;
  }

  // Other tasks are live on the computer: looking at the screen again and again would take the
  // screen from them.
  shared(cellId: string): boolean {
    return this.deps.live.sessionsOn(cellId).length > 1;
  }

  // `waiting` ends only the wait for the turn, never the turn once it is taken.
  async take(
    sessionId: string,
    cellId: string,
    signal: AbortSignal,
    user = false,
    waiting = signal,
  ): Promise<ComputerTurn> {
    const lease = this.deps.live.lease(cellId);
    const owners = this.owners(cellId);
    let grant: ComputerGrant | undefined = await lease.acquire(sessionId, {
      signal: waiting,
      user,
    });
    if (user) this.deps.screens?.forUser(cellId, sessionId);
    try {
      await this.#raise(sessionId, cellId, signal, user);
    } catch (error) {
      grant.release();
      throw error;
    }
    const end = async () => {
      const held = grant;
      grant = undefined;
      if (!held) return;
      try {
        const snapshot = await this.#read(cellId, {}, AbortSignal.timeout(WINDOWS_MS));
        if (snapshot) owners.end(sessionId, snapshot);
      } catch {
        // The turn ends whether or not the windows could be read.
      } finally {
        held.release();
      }
    };
    return {
      sessionId,
      foreign: (windowId) => owners.foreign(sessionId, windowId),
      hidden: async (shown) => {
        const snapshot = await this.#read(cellId, {}, signal);
        if (snapshot) owners.learn(snapshot, sessionId);
        else if (!shown) return [];
        return hiddenParts(
          shown ?? snapshot?.windows ?? [],
          (id) => owners.foreign(sessionId, id) || (!!snapshot && !owners.known(id)),
        );
      },
      yielding: async (work) => {
        // A step that already gave way has nothing more to give, or to take back here.
        if (!grant) return work(async () => {});
        await end();
        let back: Promise<void> | undefined;
        const resume = () => {
          back ??= (async () => {
            grant = await lease.acquire(sessionId, { signal, user });
            try {
              await this.#raise(sessionId, cellId, signal, user);
            } catch (error) {
              grant?.release();
              grant = undefined;
              throw error;
            }
          })();
          return back;
        };
        const result = await work(resume);
        await resume();
        return result;
      },
      release: end,
    };
  }

  async #raise(
    sessionId: string,
    cellId: string,
    signal: AbortSignal,
    user: boolean,
  ): Promise<void> {
    const owners = this.owners(cellId);
    const browser = user ? undefined : this.deps.browser?.(sessionId);
    if (!browser && !user) this.deps.screens?.coming(cellId, sessionId);
    let snapshot = await this.#read(cellId, {}, signal);
    if (snapshot) {
      owners.begin(sessionId, snapshot);
      if (browser) {
        await browser.enter(signal);
        return;
      }
      const target = owners.target(sessionId, snapshot);
      for (let tries = 0; target && tries < RAISES; tries++) {
        if (snapshot?.windows.find((w) => w.active)?.id === target) break;
        snapshot = await this.#read(cellId, { activate: target }, signal);
        if (!snapshot) break;
        owners.learn(snapshot);
      }
    } else if (browser) {
      await browser.enter(signal);
      return;
    }
    if (!user) this.deps.screens?.up(sessionId);
  }

  async #read(
    cellId: string,
    request: WindowsRequest,
    signal: AbortSignal,
  ): Promise<WindowsSnapshot | undefined> {
    const read = this.deps.windows(cellId);
    if (!read) return undefined;
    try {
      return await read(request, AbortSignal.any([signal, AbortSignal.timeout(WINDOWS_MS)]));
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  }
}
