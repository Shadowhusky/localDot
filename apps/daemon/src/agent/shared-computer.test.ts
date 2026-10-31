import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { LiveSessions } from "../gateway/live.ts";
import { ComputerTurns } from "./computer-turn.ts";
import { actPolicy } from "./policy.ts";
import { redactor } from "./redact.ts";
import { FakeDesktop } from "./testing/fake-desktop.ts";
import { PROXY_TOKEN, toolHarness } from "./testing/harness.ts";
import { type DispatchDeps, dispatchTool } from "./tools/index.ts";

const fixtures: (() => void)[] = [];
afterEach(() => {
  for (const close of fixtures.splice(0)) close();
});
const forever = (signal: AbortSignal) =>
  new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const CLICK = { action: "click", point: { x: 300, y: 200 } };

function setup() {
  const h = toolHarness();
  fixtures.push(h.close);
  const live = new LiveSessions();
  const desktop = new FakeDesktop();
  const turns = new ComputerTurns({ live, windows: () => (request) => desktop.read(request) });
  h.tools.computer = turns;
  h.session.computer = {
    forUser: (signal) => turns.take(h.session.id, h.session.cellId, signal, true),
  };
  const cellId = h.session.cellId;
  live.start(cellId, h.session.id, forever);
  const other = ulid();
  live.start(cellId, other, forever);
  fixtures.push(() => {
    live.stop(h.session.id);
    live.stop(other);
  });
  const deps: DispatchDeps = { tools: h.tools, policy: actPolicy };
  const call = (name: string, input: unknown) =>
    dispatchTool(deps, h.session, name, ulid(), input, redactor([PROXY_TOKEN]));
  return { ...h, live, desktop, turns, cellId, other, call };
}

describe("a task on a computer other tasks share", () => {
  it("waits its turn to act on the screen; tools off the screen never wait", async () => {
    const f = setup();
    const busy = await f.turns.take(f.other, f.cellId, AbortSignal.timeout(2000));
    const plan = await f.call("update_plan", { items: [{ text: "Draw", status: "doing" }] });
    expect(plan.result.ok).toBe(true);
    let clicked = false;
    const click = f.call("computer", CLICK).then((outcome) => {
      clicked = true;
      return outcome;
    });
    await settle();
    expect(clicked).toBe(false);
    expect(f.live.lease(f.cellId).waiting()).toEqual([f.session.id]);
    expect(f.actions).toHaveLength(0);
    await busy.release();
    expect((await click).result.ok).toBe(true);
    expect(f.actions).toHaveLength(1);
    expect(f.actions[0]?.ctx.foreign).toBeTypeOf("function");
    expect(f.live.lease(f.cellId).holder).toBeUndefined();
    expect(f.live.lease(f.cellId).last).toBe(f.session.id);
  });

  it("holds the computer for the user who takes control, and every other task waits", async () => {
    const f = setup();
    const requestId = f.session.takeControl();
    await settle();
    expect(f.session.manualControl).toBe("ready");
    expect(f.live.lease(f.cellId).userHolds).toBe(true);
    let acted = false;
    const waiting = f.turns.take(f.other, f.cellId, AbortSignal.timeout(5000)).then((turn) => {
      acted = true;
      return turn;
    });
    await settle();
    expect(acted).toBe(false);
    expect(await f.session.handback(requestId, undefined)).toBe(true);
    const turn = await waiting;
    expect(acted).toBe(true);
    await turn.release();
  });

  it("lets the user's control wait for an action already under way", async () => {
    const f = setup();
    const acting = await f.turns.take(f.other, f.cellId, AbortSignal.timeout(2000));
    f.session.takeControl();
    await settle();
    expect(f.session.manualControl).toBe("waiting");
    await acting.release();
    await settle();
    expect(f.session.manualControl).toBe("ready");
  });

  it("ends a stopped task's wait for the computer and leaves the task acting alone", async () => {
    const f = setup();
    const acting = await f.turns.take(f.other, f.cellId, AbortSignal.timeout(2000));
    const click = f.call("computer", CLICK);
    await settle();
    f.session.stop();
    expect((await click).result.ok).toBe(false);
    expect(f.live.lease(f.cellId).waiting()).toEqual([]);
    expect(f.live.lease(f.cellId).holder).toBe(f.other);
    expect(f.actions).toHaveLength(0);
    await acting.release();
  });

  it("ends the wait for another task's turn when the user sends a message, doing nothing", async () => {
    const f = setup();
    const acting = await f.turns.take(f.other, f.cellId, AbortSignal.timeout(2000));
    const click = f.call("computer", CLICK);
    await settle();
    expect(f.live.lease(f.cellId).waiting()).toEqual([f.session.id]);
    f.session.post("steer", "Click Cancel instead");
    const { result } = await click;
    expect(result.ok).toBe(false);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("the user sent a new message while this waited for its turn"),
    });
    expect(f.live.lease(f.cellId).waiting()).toEqual([]);
    expect(f.actions).toHaveLength(0);
    await acting.release();
    // With the computer free and the message answered, the next action runs.
    expect((await f.call("computer", CLICK)).result.ok).toBe(true);
    expect(f.actions).toHaveLength(1);
  });

  it("doesn't let a message waiting for dot stop an action whose turn is free", async () => {
    const f = setup();
    f.session.post("steer", "Then close the dialog");
    expect((await f.call("computer", CLICK)).result.ok).toBe(true);
    expect(f.actions).toHaveLength(1);
  });
});
