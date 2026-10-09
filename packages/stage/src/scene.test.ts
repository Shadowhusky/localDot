import { type LocalDotEvent, msToMicros, sessionMsOf } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { emptyModel, foldEvents } from "./model.ts";
import { pointerAt } from "./pointer-path.ts";
import { keycapNames, render, sceneAt } from "./scene.ts";
import { RING_FADE_MS, TARGET_HOLD_MS } from "./timing.ts";

let seq = 0;
const ev = (
  type: string,
  tMs: number,
  data: Record<string, unknown>,
  step?: string,
): LocalDotEvent =>
  ({
    v: 1,
    id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
    seq: seq++,
    t: msToMicros(tMs),
    agent: "main",
    ...(step ? { step } : {}),
    type,
    data,
  }) as LocalDotEvent;
const plan = {
  from: { x: 100, y: 100 },
  to: { x: 300, y: 400 },
  startsAt: 1120,
  durationMs: 400,
  seed: 1,
  curve: "minjerk-bow-v1" as const,
};
const base = (): LocalDotEvent[] => [
  ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux" }),
  ev("agent.state", 1, { state: "acting" }),
];
const intent = ev(
  "action.intent",
  1000,
  { verb: "click", label: "Click A", point: { x: 300, y: 400 }, risk: "none", pointer: plan },
  "s1",
);
const target = ev(
  "action.target",
  1300,
  {
    target: {
      point: { x: 300, y: 400 },
      bbox: { x: 280, y: 380, w: 40, h: 40 },
      source: "ax",
      role: "button",
      name: "A",
    },
  },
  "s1",
);
const dispatch = ev(
  "action.dispatch",
  1615,
  {
    input: { kind: "click", button: "left", count: 1, at: { x: 300, y: 400 } },
    pressT: 1_612_000,
    ringAt: 1_635_100,
    injector: "xtest",
  },
  "s1",
);
const result = ev("action.result", 2210, { ok: true }, "s1");
const view = { reducedMotion: false };
// A session's log numbers its events in order, and foldEvents skips any seq it has passed. The
// fixtures above are shared between logs, so each log is numbered by position before it is folded.
const inOrder = (log: LocalDotEvent[]): LocalDotEvent[] => log.map((e, i) => ({ ...e, seq: i }));
const fold = (log: LocalDotEvent[]) => foldEvents(emptyModel(), inOrder(log));
const motion = (log: LocalDotEvent[], t: number) => sceneAt(fold(log), t, view);

describe("cursor", () => {
  it("is hidden before the first intent, then follows the plan and sits exactly on the dispatch point", () => {
    expect(motion(base(), 500).cursor?.visible ?? false).toBe(false);
    const log = [...base(), intent, target, dispatch, result];
    expect(motion(log, 1050).cursor).toMatchObject({ x: 100, y: 100, visible: true });
    const mid = motion(log, 1300).cursor;
    const expected = pointerAt(plan, 1300);
    expect(mid?.x).toBeCloseTo(expected.x, 9);
    expect(mid?.y).toBeCloseTo(expected.y, 9);
    expect(motion(log, 1612).cursor).toMatchObject({ x: 300, y: 400 });
    expect(motion(log, 1700).cursor).toMatchObject({ x: 300, y: 400 });
  });

  it("can stop a first action with no pointer position without crashing the HUD or worker", () => {
    const log = [
      ...base(),
      ev("action.intent", 1000, { verb: "wait", label: "Wait", risk: "none" }, "s1"),
      ev("action.cancel", 1300, { reason: "user" }, "s1"),
      ev("session.end", 1301, { reason: "stopped" }),
    ];
    for (const reducedMotion of [false, true]) {
      const scene = sceneAt(fold(log), 1400, { reducedMotion });
      expect(scene.cancel).toMatchObject({ x: 0, y: 0, reason: "user" });
      expect(scene.hud.state).toBe("stopped");
      expect(scene.control).toBe(false);
    }
  });

  it("stays where it was when an action is cancelled mid-travel", () => {
    const log = [...base(), intent, ev("action.cancel", 1300, { reason: "user" }, "s1")];
    const at = pointerAt(plan, 1300);
    expect(motion(log, 1500).cursor?.x).toBeCloseTo(at.x, 9);
    expect(motion(log, 1500).cancel).toMatchObject({ reason: "user" });
  });

  it("cross-fades instead of travelling under reduced motion and never sits between the ends", () => {
    const log = [...base(), intent, dispatch, result];
    const s = sceneAt(fold(log), 1300, { reducedMotion: true });
    expect([100, 300]).toContain(s.cursor?.x);
    expect(s.cursor?.alpha).toBeLessThanOrEqual(1);
  });

  it("dims while thinking and hides after a minute idle", () => {
    const log = [
      ...base(),
      intent,
      dispatch,
      result,
      ev("agent.state", 2300, { state: "thinking" }),
    ];
    expect(motion(log, 2400).cursor?.alpha).toBeCloseTo(0.7, 6);
    expect(motion(log, 2400).cursor?.floating).toBe(true);
    // Idle from the result at 2210: resting (dimmed and floating) after 1.2 s even without a thinking
    // state (research §4.5); the fade starts a minute later and takes FADE_MS (180 ms).
    const idle = [...base(), intent, dispatch, result];
    expect(motion(idle, 2210 + 1100).cursor).toMatchObject({ alpha: 1, floating: false });
    expect(motion(idle, 2210 + 1300).cursor).toMatchObject({ alpha: 0.7, floating: true });
    expect(motion(idle, 2210 + 60_001).cursor?.visible).toBe(true);
    expect(motion(idle, 2210 + 60_001).cursor?.alpha).toBeLessThan(0.7);
    expect(motion(idle, 2210 + 60_000 + 180).cursor?.visible).toBe(false);
  });

  it("appears at the target and fades in over 150 ms in Instant mode (a plan with no travel)", () => {
    const instant = ev(
      "action.intent",
      1000,
      {
        verb: "click",
        label: "Click A",
        point: { x: 300, y: 400 },
        risk: "none",
        pointer: { ...plan, startsAt: 1000, durationMs: 0 },
      },
      "s1",
    );
    const log = [...base(), instant];
    expect(motion(log, 1000).cursor).toMatchObject({ x: 300, y: 400, visible: true, alpha: 0 });
    expect(motion(log, 1075).cursor).toMatchObject({ x: 300, y: 400 });
    expect(motion(log, 1075).cursor?.alpha).toBeCloseTo(0.5, 6);
    expect(motion(log, 1150).cursor?.alpha).toBe(1);
    expect(motion(log, 1150).cursor?.press).toBe(0);
  });
});

describe("rings and target", () => {
  const log = [...base(), intent, target, dispatch, result];
  it("shows no ring before ringAt, one ring at ringAt, none after 300 ms", () => {
    expect(motion(log, 1612).rings).toEqual([]);
    expect(motion(log, 1635).rings).toEqual([]);
    expect(motion(log, 1635.1).rings).toMatchObject([{ x: 300, y: 400, p: 0, style: "left" }]);
    expect(motion(log, 1635.1 + RING_FADE_MS - 1).rings).toHaveLength(1);
    expect(motion(log, 1635.1 + RING_FADE_MS).rings).toEqual([]);
  });

  it("draws two rings 90 ms apart for a double click and a dashed one for the right button", () => {
    const dbl = ev(
      "action.dispatch",
      1615,
      {
        input: { kind: "click", button: "right", count: 2, at: { x: 300, y: 400 } },
        pressT: 1_612_000,
        ringAt: 1_635_100,
        injector: "xtest",
      },
      "s1",
    );
    const s = motion([...base(), intent, dbl, result], 1730);
    expect(s.rings).toHaveLength(2);
    expect(s.rings[0]?.style).toBe("right");
    expect((s.rings[0]?.p ?? 0) - (s.rings[1]?.p ?? 0)).toBeCloseTo(90 / RING_FADE_MS, 6);
  });

  it("shows a crosshair until the target arrives, then the box, held 900 ms after dispatch", () => {
    expect(motion(log, 1200).target).toMatchObject({
      style: "acting",
      rect: null,
      point: { x: 300, y: 400 },
    });
    // One second after the target event the critically damped spring (response 0.31 s) has
    // settled to within 1e-3 px; the box is still held (dispatch 1615 + 900 + 300 = 2815).
    const boxed = motion(log, 1300 + 1000).target;
    expect(boxed?.rect?.x).toBeCloseTo(280, 3);
    expect(boxed?.rect?.y).toBeCloseTo(380, 3);
    expect(boxed?.rect?.w).toBeCloseTo(40, 3);
    expect(boxed?.rect?.h).toBeCloseTo(40, 3);
    expect(boxed?.chip).toBe("button · A");
    expect(boxed?.alpha).toBe(1);
    expect(motion(log, 1615 + TARGET_HOLD_MS + 299).target?.alpha).toBeGreaterThan(0);
    expect(motion(log, 1615 + TARGET_HOLD_MS + 301).target).toBeNull();
  });

  it("morphs the box with a spring and snaps under reduced motion", () => {
    const early = motion(log, 1310).target?.rect;
    expect(early?.w).toBeGreaterThan(36);
    expect(early?.w).toBeLessThan(40);
    const snap = sceneAt(fold(log), 1310, { reducedMotion: true }).target?.rect;
    expect(snap).toEqual({ x: 280, y: 380, w: 40, h: 40 });
  });
});

describe("typing and keys", () => {
  const typeIntent = ev(
    "action.intent",
    1000,
    { verb: "type", label: 'Type "hello world"', point: { x: 200, y: 200 }, risk: "none" },
    "s2",
  );
  const typeDispatch = ev(
    "action.dispatch",
    1100,
    {
      input: { kind: "type", chars: 11, masked: false },
      pressT: 1_098_000,
      ringAt: 1_127_300,
      injector: "xtest",
    },
    "s2",
  );
  const progress = (t: number, count: number, chunk: string) =>
    ev("text.progress", t, { count, chunk, masked: false }, "s2");
  const log = [
    ...base(),
    typeIntent,
    typeDispatch,
    progress(1130, 1, "h"),
    progress(1165, 2, "e"),
    progress(1200, 5, "llo"),
    progress(1400, 11, " world"),
    ev("action.result", 1900, { ok: true }, "s2"),
  ];

  it("never shows more characters than typed and holds the pill 500 ms after the last chunk", () => {
    expect(motion(log, 1120).typing).toBeNull();
    expect(motion(log, 1130).typing?.text).toBe("h");
    expect(motion(log, 1199).typing?.text).toBe("he");
    expect(motion(log, 1200).typing?.text).toBe("hello");
    expect(motion(log, 1500).typing?.text).toBe("hello world");
    for (const t of [1130, 1150, 1199, 1250, 1399, 1400, 1800]) {
      const typed = log
        .filter((e) => e.type === "text.progress" && sessionMsOf(e) <= t)
        .map((e) => (e.type === "text.progress" ? e.data.count : 0));
      expect(
        (motion(log, t).typing?.text.length ?? 0) + (motion(log, t).typing?.more ?? 0),
      ).toBeLessThanOrEqual(Math.max(0, ...typed));
    }
    // The result (1900) came after the last progress line (1400): the hold counts from the result.
    expect(motion(log, 1900 + 499).typing).not.toBeNull();
    expect(motion(log, 1900 + 501).typing).toBeNull();
    // The other order: a last chunk after the result keeps the pill until that chunk + 500 ms.
    const lateChunk = [
      ...log.filter((e) => e.type !== "action.result"),
      ev("action.result", 1300, { ok: true }, "s2"),
    ];
    expect(motion(lateChunk, 1400 + 499).typing?.text).toBe("hello world");
    expect(motion(lateChunk, 1400 + 501).typing).toBeNull();
  });

  it("renders masked typing as dots and never more characters than typed", () => {
    const masked = [
      ...base(),
      typeIntent,
      ev(
        "action.dispatch",
        1100,
        {
          input: { kind: "type", chars: 7, masked: true },
          pressT: 1_098_000,
          ringAt: 1_127_300,
          injector: "xtest",
        },
        "s2",
      ),
      ev("text.progress", 1200, { count: 3, masked: true }, "s2"),
      ev("text.progress", 1400, { count: 7, masked: true }, "s2"),
    ];
    expect(motion(masked, 1300).typing).toMatchObject({ text: "•••", masked: true });
    expect(motion(masked, 1500).typing?.text).toBe("•••••••");
  });

  it("truncates a long paste to the last 60 characters with a +N more count", () => {
    const long = [
      ...base(),
      typeIntent,
      typeDispatch,
      ev("text.progress", 1200, { count: 100, chunk: "x".repeat(100), masked: false }, "s2"),
    ];
    expect(motion(long, 1300).typing).toMatchObject({ more: 40 });
    expect(motion(long, 1300).typing?.text.length).toBe(60);
  });

  it("shows keycaps for a combo from the key onset, popping in then fading", () => {
    const keys = [
      ...base(),
      ev("action.intent", 1000, { verb: "key", label: "Press Ctrl+L", risk: "none" }, "s3"),
      ev(
        "action.dispatch",
        1100,
        {
          input: { kind: "key", combo: ["ctrl", "l"] },
          pressT: 1_098_000,
          ringAt: 1_127_300,
          injector: "xtest",
        },
        "s3",
      ),
    ];
    expect(motion(keys, 1120).keycaps).toBeNull();
    expect(motion(keys, 1127.3).keycaps).toMatchObject({ keys: ["Ctrl", "L"], scale: 0.5, dy: 20 });
    expect(motion(keys, 1127.3 + 200).keycaps).toMatchObject({ scale: 1, dy: 0 });
    expect(motion(keys, 1127.3 + 200 + 1500 + 301).keycaps).toBeNull();
    expect(keycapNames(["ctrl", "shift", "s"])).toEqual(["Ctrl", "Shift", "S"]);
    expect(keycapNames(["Return"])).toEqual(["Return"]);
  });
});

describe("drag path", () => {
  const travel = (from: { x: number; y: number }, to: { x: number; y: number }, at: number) => ({
    from,
    to,
    startsAt: at,
    durationMs: 200,
    seed: 3,
    curve: "minjerk-bow-v1" as const,
  });
  const step = (n: number, verb: string, label: string, pointer?: object) =>
    ev("action.intent", n, { verb, label, risk: "none", ...(pointer ? { pointer } : {}) }, label);
  const sent = (n: number, input: object, label: string, pressMs = n) =>
    ev(
      "action.dispatch",
      n,
      { input, pressT: msToMicros(pressMs), ringAt: msToMicros(pressMs), injector: "xtest" },
      label,
    );
  const done = (n: number, label: string) => ev("action.result", n, { ok: true }, label);
  const from = { x: 200, y: 200 };
  const to = { x: 1200, y: 600 };

  it("draws a one-step drag's path as it goes, moves the cursor along it, then fades it after the drop", () => {
    const input = {
      kind: "drag",
      from,
      to,
      path: [{ x: 700, y: 200 }],
      button: "left",
      durationMs: 1000,
    };
    const log = [
      ...base(),
      step(1000, "drag", "drag", travel({ x: 0, y: 0 }, from, 1000)),
      sent(1300, input, "drag"),
      done(2500, "drag"),
    ];
    expect(motion(log, 1200).drag).toBeNull();
    const early = motion(log, 1500);
    expect(early.drag?.points[0]).toEqual(from);
    expect(early.drag?.points.length).toBeGreaterThan(2);
    expect(early.drag?.points.every((p) => p.y === 200)).toBe(true);
    expect(early.cursor).toMatchObject(early.drag?.points.at(-1) ?? {});
    const late = motion(log, 2200);
    expect(late.drag?.points.at(-1)?.y).toBeGreaterThan(200);
    expect(late.drag?.points.length).toBeGreaterThan(early.drag?.points.length ?? 0);
    expect(motion(log, 2600).drag).toEqual({ points: [from, { x: 700, y: 200 }, to], alpha: 1 });
    expect(motion(log, 2600).cursor).toMatchObject(to);
    expect(motion(log, 3250).drag?.alpha).toBeCloseTo(0.5, 1);
    expect(motion(log, 3500).drag).toBeNull();
  });

  it("stops the path where a stopped drag was cancelled", () => {
    const input = { kind: "drag", from, to, button: "left", durationMs: 1000 };
    const log = [
      ...base(),
      step(1000, "drag", "drag", travel({ x: 0, y: 0 }, from, 1000)),
      sent(1300, input, "drag"),
      ev("action.cancel", 1800, { reason: "user" }, "drag"),
    ];
    const stopped = motion(log, 1800).drag?.points.at(-1);
    expect(motion(log, 2000).drag?.points.at(-1)).toEqual(stopped);
    expect(stopped?.x).toBeGreaterThan(from.x);
    expect(stopped?.x).toBeLessThan(to.x);
  });

  it("follows a button held between actions through each move and its release", () => {
    const a = { x: 600, y: 300 };
    const log = [
      ...base(),
      step(1000, "click", "down", travel({ x: 0, y: 0 }, from, 1000)),
      sent(1250, { kind: "down", button: "left", at: from }, "down"),
      done(1300, "down"),
      step(2000, "move", "move", travel(from, a, 2000)),
      sent(2200, { kind: "move", to: a, durationMs: 200 }, "move"),
      done(2300, "move"),
      step(3000, "click", "up", travel(a, to, 3000)),
      sent(3200, { kind: "up", button: "left", at: to }, "up"),
      done(3300, "up"),
    ];
    // The press alone is no path yet; the travel to it is no drag.
    expect(motion(log, 1100).drag).toBeNull();
    expect(motion(log, 1500).drag).toBeNull();
    const gliding = motion(log, 2100);
    expect(gliding.drag?.points[0]).toEqual(from);
    const head = gliding.drag?.points.at(-1) as { x: number; y: number };
    // On the straight line the button glides along, with the cursor on it.
    expect(head.x).toBeGreaterThan(from.x);
    expect(
      Math.abs((head.y - from.y) / (head.x - from.x) - (a.y - from.y) / (a.x - from.x)),
    ).toBeLessThan(0.01);
    expect(gliding.cursor).toMatchObject(head);
    expect(motion(log, 2500).drag?.points).toEqual([from, a]);
    expect(motion(log, 3400).drag?.points).toEqual([from, a, to]);
    expect(motion(log, 4300).drag).toBeNull();
  });

  it("ends the held path at an automatic release, and draws it whole at once under reduced motion", () => {
    const a = { x: 600, y: 300 };
    const log = [
      ...base(),
      step(1000, "click", "down"),
      sent(1000, { kind: "down", button: "left", at: from }, "down"),
      done(1010, "down"),
      step(2000, "move", "move", travel(from, a, 2000)),
      ev("action.intent", 2600, {
        verb: "click",
        label: "Release the left button, cancelling the drag",
        risk: "none",
      }),
      ev("action.dispatch", 2610, {
        input: { kind: "up", button: "left", at: a },
        pressT: msToMicros(2610),
        ringAt: msToMicros(2610),
        injector: "xtest",
      }),
      ev("action.result", 2620, { ok: true }),
    ];
    expect(sceneAt(fold(log), 2050, { reducedMotion: true }).drag?.points).toEqual([from, a]);
    expect(motion(log, 2700).drag?.points).toEqual([from, a]);
    expect(motion(log, 3600).drag).toBeNull();
  });
});

describe("hud and control", () => {
  it("lights control while the agent acts and turns it off at the end", () => {
    const log = [
      ...base(),
      intent,
      dispatch,
      result,
      ev("agent.state", 2300, { state: "done" }),
      ev("session.end", 2301, { reason: "done" }),
    ];
    expect(motion(log, 1500)).toMatchObject({
      control: true,
      hud: { label: "Click A", state: "working" },
    });
    expect(motion(log, 2400)).toMatchObject({ control: false, hud: { state: "done" } });
    expect(motion(log, 1500).hud.elapsedMs).toBe(1500);
  });

  it("reads the agent state in effect at t, not the latest one", () => {
    const log = [
      ...base(),
      intent,
      dispatch,
      result,
      ev("agent.state", 2300, { state: "thinking" }),
      ev("agent.state", 2600, { state: "acting" }),
    ];
    expect(motion(log, 2400).cursor?.floating).toBe(true);
    expect(motion(log, 2700).cursor?.alpha).toBe(1);
    expect(motion(log, 2700).hud.label).toBe("Click A");
    expect(motion([...base(), ev("agent.state", 500, { state: "thinking" })], 400).hud.label).toBe(
      "",
    );
  });
});

describe("determinism", () => {
  it("renders the same log identically twice at many times", () => {
    const log = [...base(), intent, target, dispatch, result];
    for (let t = 900; t < 3000; t += 7.3)
      expect(render(inOrder(log), t, view)).toEqual(render(inOrder(log), t, view));
  });
});

it("renders the first cancelled action without a pointer plan at a safe resting point", () => {
  const log = [
    ev("action.intent", 0, { verb: "wait", label: "Wait", risk: "none" }),
    ev("action.cancel", 10, { reason: "stale" }),
  ];
  expect(render(log, 11, { reducedMotion: false }).cancel).toMatchObject({
    x: 0,
    y: 0,
    reason: "stale",
  });
});
