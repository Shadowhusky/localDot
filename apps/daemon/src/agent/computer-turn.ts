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
  live: Pick<LiveSessions, "lease" | "cellOf">;
  // The computer's window list; undefined when it has none to give (an older desktop).
  windows(cellId: string): ReadWindows | undefined;
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

  async take(
    sessionId: string,
    cellId: string,
    signal: AbortSignal,
    user = false,
  ): Promise<ComputerTurn> {
    const lease = this.deps.live.lease(cellId);
    const owners = this.owners(cellId);
    let grant: ComputerGrant | undefined = await lease.acquire(sessionId, { signal, user });
    try {
      await this.#raise(sessionId, cellId, signal);
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
        await end();
        let back: Promise<void> | undefined;
        const resume = () => {
          back ??= (async () => {
            grant = await lease.acquire(sessionId, { signal, user });
            try {
              await this.#raise(sessionId, cellId, signal);
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

  async #raise(sessionId: string, cellId: string, signal: AbortSignal): Promise<void> {
    const owners = this.owners(cellId);
    let snapshot = await this.#read(cellId, {}, signal);
    if (!snapshot) return;
    owners.begin(sessionId, snapshot);
    const target = owners.target(sessionId, snapshot);
    for (let tries = 0; target && tries < RAISES; tries++) {
      if (snapshot?.windows.find((w) => w.active)?.id === target) return;
      snapshot = await this.#read(cellId, { activate: target }, signal);
      if (!snapshot) return;
      owners.learn(snapshot);
    }
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
