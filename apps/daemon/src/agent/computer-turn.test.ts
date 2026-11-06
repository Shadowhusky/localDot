import { describe, expect, it } from "vitest";
import { LiveSessions } from "../gateway/live.ts";
import { ComputerTurns } from "./computer-turn.ts";
import { FakeDesktop } from "./testing/fake-desktop.ts";

const forever = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));

function fixture() {
  const live = new LiveSessions();
  const desktop = new FakeDesktop();
  const turns = new ComputerTurns({ live, windows: () => (request) => desktop.read(request) });
  for (const id of ["a", "b"]) live.start("cell", id, forever);
  return { live, desktop, turns };
}

describe("turns on a shared computer", () => {
  it("brings the task's own window forward before it acts, past another task's", async () => {
    const f = fixture();
    let turn = await f.turns.take("a", "cell", AbortSignal.timeout(1000));
    const mine = f.desktop.open();
    await turn.release();
    turn = await f.turns.take("b", "cell", AbortSignal.timeout(1000));
    const theirs = f.desktop.open();
    await turn.release();
    expect(f.desktop.active).toBe(theirs);
    turn = await f.turns.take("a", "cell", AbortSignal.timeout(1000));
    expect(f.desktop.active).toBe(mine);
    expect(turn.foreign(theirs)).toBe(true);
    expect(turn.foreign(mine)).toBe(false);
    await turn.release();
  });

  it("refuses another task's window that keeps the focus", async () => {
    const f = fixture();
    let turn = await f.turns.take("a", "cell", AbortSignal.timeout(1000));
    const mine = f.desktop.open();
    await turn.release();
    turn = await f.turns.take("b", "cell", AbortSignal.timeout(1000));
    const theirs = f.desktop.open();
    await turn.release();
    f.desktop.stuck = theirs;
    turn = await f.turns.take("a", "cell", AbortSignal.timeout(1000));
    expect(f.desktop.active).toBe(theirs);
    expect(turn.foreign(f.desktop.active)).toBe(true);
    expect(turn.foreign(mine)).toBe(false);
    await turn.release();
  });

  it("lets others act while a task waits for the user, then takes its turn and window back", async () => {
    const f = fixture();
    let turn = await f.turns.take("a", "cell", AbortSignal.timeout(1000));
    const mine = f.desktop.open();
    const order: string[] = [];
    const waited = turn.yielding(async (resume) => {
      const other = await f.turns.take("b", "cell", AbortSignal.timeout(1000));
      f.desktop.open();
      order.push("b acted");
      const back = resume();
      await other.release();
      await back;
      order.push("a resumed");
      return "approved";
    });
    expect(await waited).toBe("approved");
    expect(order).toEqual(["b acted", "a resumed"]);
    expect(f.live.lease("cell").holder).toBe("a");
    expect(f.desktop.active).toBe(mine);
    await turn.release();
    expect(f.live.lease("cell").holder).toBeUndefined();
    turn = await f.turns.take("b", "cell", AbortSignal.timeout(1000));
    await turn.release();
  });

  it("holds the computer for the user ahead of waiting tasks", async () => {
    const f = fixture();
    f.live.start("cell", "c", forever);
    const acting = await f.turns.take("a", "cell", AbortSignal.timeout(1000));
    const waiting = f.turns.take("c", "cell", AbortSignal.timeout(1000));
    const user = f.turns.take("b", "cell", AbortSignal.timeout(1000), true);
    await acting.release();
    const held = await user;
    expect(f.live.lease("cell").userHolds).toBe(true);
    expect(f.live.lease("cell").waiting()).toEqual(["c"]);
    await held.release();
    await (await waiting).release();
  });

  it("goes on unraised on a computer that can't list its windows", async () => {
    const live = new LiveSessions();
    live.start("cell", "a", forever);
    const turns = new ComputerTurns({ live, windows: () => undefined });
    const turn = await turns.take("a", "cell", AbortSignal.timeout(1000));
    expect(turn.foreign(7)).toBe(false);
    await turn.release();
    expect(live.lease("cell").holder).toBeUndefined();
  });
});

describe("what a task sees of a shared computer", () => {
  it("hides another task's window and one that showed too late to tell, never its own", async () => {
    const f = fixture();
    let turn = await f.turns.take("b", "cell", AbortSignal.timeout(1000));
    const theirs = f.desktop.open();
    await turn.release();
    turn = await f.turns.take("a", "cell", AbortSignal.timeout(1000));
    const mine = f.desktop.open();
    const frame = { x: 0, y: 0, w: 640, h: 400 };
    const late = { id: 999, frame: { x: 700, y: 0, w: 100, h: 100 } };
    expect(await turn.hidden([{ id: mine, frame }, late])).toEqual([late.frame]);
    const lower = { id: theirs, frame: { x: 0, y: 0, w: 900, h: 500 } };
    expect(await turn.hidden([{ id: mine, frame }, lower])).toEqual([
      { x: 0, y: 400, w: 900, h: 100 },
      { x: 640, y: 0, w: 260, h: 400 },
    ]);
    await turn.release();
  });

  it("brings a task on the web browser forward there, and leaves the desktop as it is", async () => {
    const live = new LiveSessions();
    const desktop = new FakeDesktop();
    const entered: string[] = [];
    const turns = new ComputerTurns({
      live,
      windows: () => (request) => desktop.read(request),
      browser: (id) =>
        id === "web"
          ? {
              enter: async () => {
                entered.push(id);
              },
            }
          : undefined,
    });
    for (const id of ["web", "local"]) live.start("cell", id, forever);
    let turn = await turns.take("local", "cell", AbortSignal.timeout(1000));
    const mine = desktop.open();
    await turn.release();
    turn = await turns.take("web", "cell", AbortSignal.timeout(1000));
    expect(entered).toEqual(["web"]);
    expect(desktop.active).toBe(mine);
    await turn.release();
  });

  it("takes the turn back through the browser when a task gives way while its page loads", async () => {
    const live = new LiveSessions();
    const desktop = new FakeDesktop();
    let entries = 0;
    const turns = new ComputerTurns({
      live,
      windows: () => (request) => desktop.read(request),
      browser: () => ({
        enter: async () => {
          entries++;
        },
      }),
    });
    for (const id of ["a", "b"]) live.start("cell", id, forever);
    const turn = await turns.take("a", "cell", AbortSignal.timeout(1000));
    expect(entries).toBe(1);
    await turn.yielding(async () => {
      expect(live.lease("cell").holder).toBeUndefined();
      const other = await turns.take("b", "cell", AbortSignal.timeout(1000));
      await other.release();
    });
    expect(entries).toBe(3);
    expect(live.lease("cell").holder).toBe("a");
    await turn.release();
  });

  it("gives way once, however many steps inside it ask to", async () => {
    const f = fixture();
    const turn = await f.turns.take("a", "cell", AbortSignal.timeout(1000));
    await turn.yielding(async () => {
      await turn.yielding(async () => {
        expect(f.live.lease("cell").holder).toBeUndefined();
      });
      expect(f.live.lease("cell").holder).toBeUndefined();
    });
    expect(f.live.lease("cell").holder).toBe("a");
    await turn.release();
    expect(f.live.lease("cell").holder).toBeUndefined();
  });

  it("releases a turn whose window could not be brought forward", async () => {
    const live = new LiveSessions();
    const desktop = new FakeDesktop();
    const turns = new ComputerTurns({
      live,
      windows: () => (request) => desktop.read(request),
      browser: () => ({
        enter: async () => {
          throw new Error("stopped");
        },
      }),
    });
    live.start("cell", "a", forever);
    await expect(turns.take("a", "cell", AbortSignal.timeout(1000))).rejects.toThrow("stopped");
    expect(live.lease("cell").holder).toBeUndefined();
  });

  it("tells the recordings whose work the desktop shows, and the user's turn on either screen", async () => {
    const live = new LiveSessions();
    const desktop = new FakeDesktop();
    const said: string[] = [];
    const turns = new ComputerTurns({
      live,
      windows: () => (request) => desktop.read(request),
      screens: {
        coming: (_cell, id) => said.push(`coming ${id}`),
        up: (id) => said.push(`up ${id}`),
        forUser: (_cell, id) => said.push(`user ${id}`),
      },
    });
    live.start("cell", "a", forever);
    const turn = await turns.take("a", "cell", AbortSignal.timeout(1000));
    await turn.release();
    const user = await turns.take("a", "cell", AbortSignal.timeout(1000), true);
    await user.release();
    expect(said).toEqual(["coming a", "up a", "user a"]);
  });
});
