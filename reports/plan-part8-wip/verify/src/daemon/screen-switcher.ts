import type { LeaseReply } from "../protocol/browserd.ts";
import type { ScreenGeometry, ScreenName, ScreenSwitchData } from "../protocol/screens.ts";
import type { ScreenControl } from "./screen-control.ts";

export class ScreenBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenBusyError";
  }
}

export interface ScreenSession {
  id: string;
  cellId: string; // the computer: its desktop cell
  signal: AbortSignal;
}

export interface ScreenSwitcherDeps {
  // Starts the computer's browser cell if it is not running and waits until it is ready.
  ensureBrowser(computerId: string, signal: AbortSignal): Promise<{ cellId: string }>;
  geometryOf(cellId: string): ScreenGeometry;
  control: Pick<ScreenControl, "grant">;
  append(sessionId: string, type: "screen.switch", data: ScreenSwitchData, step?: string): void;
}

interface Screens {
  screen: ScreenName;
  cellId: string;
  takeover?: { screen: ScreenName; cellId: string };
  lock: Promise<unknown>;
}

export interface SwitchOutcome {
  screen: ScreenName;
  cellId: string;
  changed: boolean;
}

// One lock per session orders switch_screen, the start of a takeover and the hand-back
// (Review Focus 4, P8-R10). A takeover is granted on the screen the agent is on once any switch in
// flight has finished; while the user holds a screen, the agent can neither switch nor act.
export class ScreenSwitcher {
  readonly #sessions = new Map<string, Screens>();

  constructor(private readonly deps: ScreenSwitcherDeps) {}

  #of(session: Pick<ScreenSession, "id" | "cellId">): Screens {
    let s = this.#sessions.get(session.id);
    if (!s) {
      s = { screen: "desktop", cellId: session.cellId, lock: Promise.resolve() };
      this.#sessions.set(session.id, s);
    }
    return s;
  }

  #locked<T>(session: Pick<ScreenSession, "id" | "cellId">, fn: (s: Screens) => Promise<T>): Promise<T> {
    const s = this.#of(session);
    const run = s.lock.then(() => fn(s));
    s.lock = run.catch(() => {});
    return run;
  }

  active(session: Pick<ScreenSession, "id" | "cellId">): { screen: ScreenName; cellId: string } {
    const s = this.#of(session);
    return { screen: s.screen, cellId: s.cellId };
  }

  userHolds(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.takeover !== undefined;
  }

  switchTo(session: ScreenSession, screen: ScreenName, step?: string): Promise<SwitchOutcome> {
    return this.#locked(session, async (s) => {
      if (s.takeover) throw new ScreenBusyError(`the user has control of the ${s.takeover.screen} screen`);
      if (s.screen === screen) return { screen, cellId: s.cellId, changed: false };
      session.signal.throwIfAborted();
      const cellId = screen === "desktop" ? session.cellId : (await this.deps.ensureBrowser(session.cellId, session.signal)).cellId;
      session.signal.throwIfAborted();
      if (screen === "browser") await this.deps.control.grant(cellId, "agent");
      session.signal.throwIfAborted();
      s.screen = screen;
      s.cellId = cellId;
      this.deps.append(session.id, "screen.switch", { screen, cellId, geometry: this.deps.geometryOf(cellId), by: "agent" }, step);
      return { screen, cellId, changed: true };
    });
  }

  beginTakeover(session: Pick<ScreenSession, "id" | "cellId">): Promise<{ screen: ScreenName; cellId: string }> {
    return this.#locked(session, async (s) => {
      if (s.takeover) throw new ScreenBusyError("the user already has control");
      await this.deps.control.grant(s.cellId, "user");
      s.takeover = { screen: s.screen, cellId: s.cellId };
      return { ...s.takeover };
    });
  }

  endTakeover(session: Pick<ScreenSession, "id" | "cellId">): Promise<LeaseReply | undefined> {
    return this.#locked(session, async (s) => {
      const t = s.takeover;
      if (!t) return undefined;
      const reply = await this.deps.control.grant(t.cellId, "agent");
      s.takeover = undefined;
      return reply;
    });
  }

  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}
