import { type LocalDotEvent, msToMicros, sessionMsOf } from "@localdot/protocol";
import { motionSamples } from "@localdot/protocol/motion";
import { describe, expect, it } from "vitest";
import { emptyModel, foldEvents } from "./model.ts";
import { glideAt } from "./pointer-path.ts";
import { dragSegmentAlpha, keycapNames, render, sceneAt } from "./scene.ts";
import { CLICK_HOLD_MS, RING_FADE_MS, RIPPLE_GAP_MS, TARGET_HOLD_MS } from "./timing.ts";

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
    const expected = glideAt(plan, 1300);
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
      expect(scene.cancel).toMatchObject({ x: 0, y: 0, text: "Stopped" });
      expect(scene.hud.state).toBe("stopped");
      expect(scene.control).toBe(false);
    }
  });

  it("stays where it was when an action is cancelled mid-travel", () => {
    const log = [...base(), intent, ev("action.cancel", 1300, { reason: "stale" }, "s1")];
    const at = glideAt(plan, 1300);
    expect(motion(log, 1500).cursor?.x).toBeCloseTo(at.x, 9);
    expect(motion(log, 1500).cancel).toMatchObject({
      x: at.x,
      y: at.y,
      text: "Couldn't click: the screen changed",
    });
    // The blocked chip takes the name chip's place while it shows.
    expect(motion(log, 1500).cursor?.chipAlpha).toBe(0);
  });

  it("cross-fades instead of travelling under reduced motion and never sits between the ends", () => {
    const log = [...base(), intent, dispatch, result];
    const s = sceneAt(fold(log), 1300, { reducedMotion: true });
    expect([100, 300]).toContain(s.cursor?.x);
    expect(s.cursor?.alpha).toBeLessThanOrEqual(1);
  });

  it("stays opaque at rest and hides after a minute idle", () => {
    const idle = [
      ...base(),
      intent,
      dispatch,
      result,
      ev("agent.state", 2300, { state: "thinking" }),
    ];
    expect(motion(idle, 2400).cursor?.alpha).toBe(1);
    expect(motion(idle, 2210 + 60_001).cursor?.visible).toBe(true);
    expect(motion(idle, 2210 + 60_001).cursor?.alpha).toBeLessThan(1);
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

describe("glide, lean and chip", () => {
  const right = {
    from: { x: 100, y: 400 },
    to: { x: 900, y: 400 },
    startsAt: 1120,
    durationMs: 400,
    seed: 2,
    curve: "minjerk-bow-v1" as const,
  };
  const go = (pointer: object, at = 1000, step = "g1") =>
    ev(
      "action.intent",
      at,
      { verb: "click", label: "Click B", point: { x: 900, y: 400 }, risk: "none", pointer },
      step,
    );

  it("glides on a critically damped spring and lands on the target as the move ends", () => {
    const log = [...base(), go(right)];
    const xs = Array.from({ length: 41 }, (_, i) => motion(log, 1120 + i * 10).cursor?.x ?? 0);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] as number);
    expect(Math.max(...xs)).toBeLessThanOrEqual(900);
    // Front-loaded like a spring, not eased symmetrically: well past halfway at half time.
    expect(motion(log, 1320).cursor?.x).toBeGreaterThan(700);
    expect(motion(log, 1519.9).cursor?.x).toBeCloseTo(900, 0);
    expect(motion(log, 1520).cursor).toMatchObject({ x: 900, y: 400 });
  });

  it("leans up to 4° toward the travel and stands upright again at rest", () => {
    const log = [...base(), go(right)];
    const leans = Array.from(
      { length: 80 },
      (_, i) => motion(log, 1120 + i * 10).cursor?.lean ?? 0,
    );
    expect(Math.max(...leans)).toBeGreaterThan(0.03);
    expect(Math.max(...leans)).toBeLessThanOrEqual((4 * Math.PI) / 180 + 1e-9);
    expect(motion(log, 1520 + 400).cursor?.lean).toBe(0);
    const left = [...base(), go({ ...right, from: right.to, to: right.from })];
    expect(motion(left, 1300).cursor?.lean).toBeLessThan(0);
    expect(sceneAt(fold(log), 1300, { reducedMotion: true }).cursor?.lean).toBe(0);
  });

  it("fades out at the old point and in at the new one under reduced motion", () => {
    const log = [...base(), go(right)];
    const at = (t: number) => sceneAt(fold(log), t, { reducedMotion: true }).cursor;
    expect(at(1150)).toMatchObject({ x: 100, alpha: 0.5 });
    expect(at(1180)).toMatchObject({ x: 900, alpha: 0 });
    expect(at(1240)?.alpha).toBeCloseTo(0.5, 6);
    expect(at(1300)).toMatchObject({ x: 900, alpha: 1 });
  });

  it("shows the name chip as the cursor sets off and fades it after 2 s still, without a blink between moves", () => {
    const log = [...base(), go(right)];
    expect(motion(log, 1180).cursor?.chipAlpha).toBeCloseTo(0.5, 6);
    expect(motion(log, 1520 + 2000).cursor?.chipAlpha).toBe(1);
    expect(motion(log, 1520 + 2200).cursor?.chipAlpha).toBeCloseTo(0.5, 6);
    expect(motion(log, 1520 + 2400).cursor?.chipAlpha).toBe(0);
    const next = { ...right, from: right.to, to: { x: 400, y: 600 }, startsAt: 2620 };
    const two = [...log, go(next, 2500, "g2")];
    for (const t of [2600, 2620, 2650, 2700]) expect(motion(two, t).cursor?.chipAlpha).toBe(1);
  });
});

describe("press, ripples and target", () => {
  const log = [...base(), intent, target, dispatch, result];
  const release = 1612 + CLICK_HOLD_MS;

  it("presses the disc in on the raw press and releases it into a ripple after the hold", () => {
    expect(motion(log, 1611).press).toBeNull();
    expect(motion(log, 1611).cursor?.press).toBe(0);
    const down = motion(log, 1612 + 80);
    expect(down.press).toMatchObject({ x: 300, y: 400, alpha: 1 });
    expect(down.press?.scale).toBeLessThan(0.9);
    expect(down.press?.scale).toBeGreaterThanOrEqual(0.82);
    expect(down.cursor?.press).toBeGreaterThan(0.5);
    expect(down.rings).toEqual([]);
    const up = motion(log, release + 1);
    expect(up.rings).toHaveLength(1);
    expect(up.rings[0]).toMatchObject({ x: 300, y: 400, style: "left" });
    expect(up.rings[0]?.d).toBeCloseTo(28, 0);
    expect(up.rings[0]?.alpha).toBeCloseTo(0.6, 2);
    const later = motion(log, release + 300);
    expect(later.rings[0]?.d).toBeGreaterThan(60);
    expect(later.rings[0]?.d).toBeLessThanOrEqual(64);
    expect(later.press).toBeNull();
    expect(motion(log, release + RING_FADE_MS).rings).toEqual([]);
    expect(motion(log, release + 400).cursor?.press).toBe(0);
  });

  it("never shows a ripple before the raw press", () => {
    for (let t = 1000; t < 1612; t += 3) expect(motion(log, t).rings).toEqual([]);
  });

  it("draws a double click as two press cycles with ripples 120 ms apart, the second larger", () => {
    const dbl = ev(
      "action.dispatch",
      1615,
      {
        input: { kind: "click", button: "left", count: 2, at: { x: 300, y: 400 } },
        pressT: 1_612_000,
        ringAt: 1_635_100,
        injector: "xtest",
      },
      "s1",
    );
    const two = [...base(), intent, dbl, result];
    const s = motion(two, release + RIPPLE_GAP_MS + 1);
    expect(s.rings).toHaveLength(2);
    expect(s.rings[1]?.d).toBeCloseTo(36, 0);
    expect(motion(two, release + RIPPLE_GAP_MS - 5).press?.scale).toBeLessThan(0.95);
    const end = motion(two, release + RIPPLE_GAP_MS + 340).rings.at(-1)?.d ?? 0;
    expect(end).toBeGreaterThan(70);
    expect(end).toBeLessThanOrEqual(76);
  });

  it("dashes a right click's ripple, stops it at 56 and names the button in the chip for 1.2 s", () => {
    const rightClick = ev(
      "action.dispatch",
      1615,
      {
        input: { kind: "click", button: "right", count: 1, at: { x: 300, y: 400 } },
        pressT: 1_612_000,
        ringAt: 1_635_100,
        injector: "xtest",
      },
      "s1",
    );
    const r = [...base(), intent, rightClick, result];
    expect(motion(r, release + 10).rings[0]?.style).toBe("right");
    expect(motion(r, release + 400).rings[0]?.d).toBeLessThanOrEqual(56);
    expect(motion(r, release - 1).cursor?.name).toBe("dot");
    expect(motion(r, release + 10).cursor?.name).toBe("dot · right-click");
    expect(motion(r, release + 1200).cursor?.name).toBe("dot");
  });

  it("keeps the disc full size and the ripples static under reduced motion", () => {
    const reduced = (t: number) => sceneAt(fold(log), t, { reducedMotion: true });
    expect(reduced(1650).press).toMatchObject({ scale: 1, alpha: 1 });
    expect(reduced(1650).cursor?.press).toBe(0);
    expect(reduced(release + 10).rings[0]).toMatchObject({ d: 32 });
    expect(reduced(release + 150).rings[0]?.d).toBe(32);
    expect(reduced(release + 150).rings[0]?.alpha).toBeCloseTo(0.3, 6);
    expect(reduced(release + 300).rings).toEqual([]);
  });

  it("rings the point until the element is known, then springs the ring in around its box", () => {
    expect(motion(log, 1200).target).toMatchObject({ rect: null, point: { x: 300, y: 400 } });
    const arriving = motion(log, 1350).target;
    expect(arriving?.rect).toEqual({ x: 280, y: 380, w: 40, h: 40 });
    expect(arriving?.scale).toBeGreaterThan(1);
    expect(arriving?.alpha).toBeLessThan(1);
    const settled = motion(log, 1300 + 800).target;
    expect(settled).toMatchObject({ scale: 1, alpha: 1 });
    const leaving = motion(log, 1615 + TARGET_HOLD_MS + 150).target;
    expect(leaving?.alpha).toBeCloseTo(0.5, 6);
    expect(leaving?.scale).toBeCloseTo(1.01, 6);
    expect(motion(log, 1615 + TARGET_HOLD_MS + 301).target).toBeNull();
  });

  it("fades the ring in without scaling under reduced motion", () => {
    const t = sceneAt(fold(log), 1375, { reducedMotion: true }).target;
    expect(t).toMatchObject({ scale: 1 });
    expect(t?.alpha).toBeCloseTo(0.5, 6);
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

  it("never shows more characters than typed, holds the pill 500 ms after the last chunk, then fades it in 200 ms", () => {
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
    expect(motion(log, 1900 + 499).typing?.alpha).toBe(1);
    expect(motion(log, 1900 + 600).typing?.alpha).toBeCloseTo(0.5, 6);
    expect(motion(log, 1900 + 700).typing).toBeNull();
    // The other order: a last chunk after the result keeps the pill until that chunk + 500 ms.
    const lateChunk = [
      ...log.filter((e) => e.type !== "action.result"),
      ev("action.result", 1300, { ok: true }, "s2"),
    ];
    expect(motion(lateChunk, 1400 + 499).typing?.text).toBe("hello world");
    expect(motion(lateChunk, 1400 + 701).typing).toBeNull();
  });

  it("rises 4 px into place on a spring, or only fades in under reduced motion", () => {
    const first = motion(log, 1127.3 + 10).typing;
    expect(first?.dy).toBeGreaterThan(3);
    expect(first?.alpha).toBeLessThan(0.1);
    expect(motion(log, 1127.3 + 700).typing).toMatchObject({ dy: 0, alpha: 1 });
    const reduced = sceneAt(fold(log), 1127.3 + 75, { reducedMotion: true }).typing;
    expect(reduced?.dy).toBe(0);
    expect(reduced?.alpha).toBeCloseTo(0.5, 6);
    expect(reduced?.caretOn).toBe(true);
  });

  it("anchors the pill to the field's box when the element is known", () => {
    const field = { x: 180, y: 190, w: 300, h: 32 };
    const known = [
      ...log.slice(0, 3),
      ev(
        "action.target",
        1050,
        { target: { point: { x: 200, y: 200 }, bbox: field, source: "ax" } },
        "s2",
      ),
      ...log.slice(3),
    ];
    expect(motion(known, 1300).typing).toMatchObject({ field, anchor: { x: 180, y: 190 } });
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

  it("shows only the last 32 characters of a long paste and counts the rest", () => {
    const long = [
      ...base(),
      typeIntent,
      typeDispatch,
      ev("text.progress", 1200, { count: 100, chunk: "x".repeat(100), masked: false }, "s2"),
    ];
    expect(motion(long, 1300).typing).toMatchObject({ more: 68 });
    expect(motion(long, 1300).typing?.text.length).toBe(32);
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
    expect(motion(keys, 1127.3)).toMatchObject({
      keycaps: { keys: ["Ctrl", "L"], scale: 0.9, dy: 8, alpha: 0 },
    });
    expect(motion(keys, 1127.3 + 75).keycaps?.alpha).toBeCloseTo(0.5, 6);
    expect(motion(keys, 1127.3 + 500).keycaps).toMatchObject({ scale: 1, dy: 0, alpha: 1 });
    expect(motion(keys, 1127.3 + 150 + 1500 + 150).keycaps?.alpha).toBeCloseTo(0.5, 6);
    expect(motion(keys, 1127.3 + 150 + 1500 + 301).keycaps).toBeNull();
    expect(sceneAt(fold(keys), 1127.3 + 10, { reducedMotion: true }).keycaps).toMatchObject({
      scale: 1,
      dy: 0,
    });
    expect(keycapNames(["ctrl", "shift", "s"])).toEqual(["Ctrl", "Shift", "S"]);
    expect(keycapNames(["super", "space"])).toEqual(["⌘", "Space"]);
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

  it("draws a one-step drag's path as it goes, moves the cursor along it, then fades it from the drop", () => {
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
    // The drop: the press, desktopd's 50 ms start and the motion's last sample.
    const drop = 1350 + (motionSamples([from, { x: 700, y: 200 }, to], 1000).at(-1)?.t ?? 0);
    const dropped = motion(log, drop + 1);
    expect(dropped.drag?.points.at(-1)).toEqual(to);
    expect(dropped.drag?.points).toContainEqual({ x: 700, y: 200 });
    expect(dropped.drag?.alpha).toBeGreaterThan(0.99);
    expect(dropped.cursor).toMatchObject(to);
    expect(dropped.rings).toMatchObject([{ x: to.x, y: to.y, style: "left" }]);
    expect(motion(log, drop + 200).drag?.alpha).toBeCloseTo(0.5, 1);
    expect(motion(log, drop + 401).drag).toBeNull();
  });

  it("fades the drawn tail by age: .85 for its last 600 ms, down to .15 by 1.2 s", () => {
    expect(dragSegmentAlpha(0)).toBe(0.85);
    expect(dragSegmentAlpha(600)).toBe(0.85);
    expect(dragSegmentAlpha(900)).toBeCloseTo(0.5, 9);
    expect(dragSegmentAlpha(1200)).toBeCloseTo(0.15, 9);
    expect(dragSegmentAlpha(5000)).toBeCloseTo(0.15, 9);
    const input = { kind: "drag", from, to, button: "left", durationMs: 1000 };
    const log = [
      ...base(),
      step(1000, "drag", "drag", travel({ x: 0, y: 0 }, from, 1000)),
      sent(1300, input, "drag"),
    ];
    const s = motion(log, 2000);
    expect(s.drag?.ages[0]).toBe(700);
    expect(s.drag?.ages.at(-1)).toBeLessThan(20);
    expect(s.drag?.ages.length).toBe(s.drag?.points.length);
    // The button stays down at the cursor the whole way.
    expect(s.press).toMatchObject({ x: s.cursor?.x, y: s.cursor?.y, alpha: 1 });
    expect(s.press?.scale).toBeCloseTo(0.82, 3);
  });

  it("shows a drag only once it is dropped under reduced motion, whole, then fades it", () => {
    const input = { kind: "drag", from, to, button: "left", durationMs: 1000 };
    const log = [
      ...base(),
      step(1000, "drag", "drag", travel({ x: 0, y: 0 }, from, 1000)),
      sent(1300, input, "drag"),
      done(2500, "drag"),
    ];
    const reduced = (t: number) => sceneAt(fold(log), t, { reducedMotion: true });
    expect(reduced(2000).drag).toBeNull();
    const whole = reduced(2400).drag;
    expect(whole?.points.at(-1)).toEqual(to);
    expect(whole?.ages.every((a) => a === 0)).toBe(true);
    expect(reduced(2800).drag).toBeNull();
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
    expect(motion(log, 2500).drag?.ages).toEqual([2500 - 1250, 2500 - 2200]);
    expect(motion(log, 3400).drag?.points).toEqual([from, a, to]);
    expect(motion(log, 3600).drag).toBeNull();
    // Held from the press to the release, then a ripple where it let go.
    expect(motion(log, 2500).press?.alpha).toBe(1);
    expect(motion(log, 3201).rings).toMatchObject([{ x: to.x, y: to.y }]);
  });

  it("ends the held path at an automatic release, and draws it whole at the release under reduced motion", () => {
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
    expect(sceneAt(fold(log), 2050, { reducedMotion: true }).drag).toBeNull();
    expect(sceneAt(fold(log), 2700, { reducedMotion: true }).drag?.points).toEqual([from, a]);
    expect(motion(log, 2700).drag?.points).toEqual([from, a]);
    expect(motion(log, 3100).drag).toBeNull();
  });
});

describe("scroll", () => {
  const scrollIntent = ev(
    "action.intent",
    1000,
    {
      verb: "scroll",
      label: "Scroll down",
      point: { x: 500, y: 500 },
      risk: "none",
      pointer: { ...plan, to: { x: 500, y: 500 } },
    },
    "s4",
  );
  const scroll = (dx: number, dy: number) => [
    ...base(),
    scrollIntent,
    ev(
      "action.dispatch",
      1600,
      {
        input: { kind: "scroll", at: { x: 500, y: 500 }, dx, dy },
        pressT: 1_600_000,
        ringAt: 1_620_000,
        injector: "xtest",
      },
      "s4",
    ),
    ev("action.result", 1700, { ok: true }, "s4"),
  ];

  it("nudges the pill once per notch, paced 90 ms apart, and fades it 600 ms after the last", () => {
    const log = scroll(0, 3);
    expect(motion(log, 1619).scroll).toBeNull();
    expect(motion(log, 1620)).toMatchObject({
      scroll: { x: 500, y: 500, direction: "down", alpha: 0 },
    });
    const peaks = [1620, 1710, 1800].map((at) => motion(log, at + 40).scroll?.nudge ?? 0);
    for (const peak of peaks) expect(peak).toBeGreaterThan(3);
    expect(motion(log, 1800 + 600).scroll?.alpha).toBe(1);
    expect(motion(log, 1800 + 700).scroll?.alpha).toBeCloseTo(0.5, 6);
    expect(motion(log, 1800 + 800).scroll).toBeNull();
    expect(sceneAt(fold(log), 1660, { reducedMotion: true }).scroll?.nudge).toBe(0);
  });

  it("points the way the page scrolls", () => {
    expect(motion(scroll(0, -2), 1700).scroll?.direction).toBe("up");
    expect(motion(scroll(4, 1), 1700).scroll?.direction).toBe("right");
    expect(motion(scroll(-4, 0), 1700).scroll?.direction).toBe("left");
  });
});

describe("blocked", () => {
  it("says what dot couldn't do in plain words and shakes for 180 ms", () => {
    const log = (reason: string) => [
      ...base(),
      intent,
      ev("action.cancel", 1300, { reason }, "s1"),
    ];
    expect(motion(log("timeout"), 1400).cancel?.text).toBe("Couldn't click: it took too long");
    expect(motion(log("preflight"), 1400).cancel?.text).toBe("Couldn't click: it wasn't there");
    expect(motion(log("model"), 1400).cancel?.text).toBe("Didn't click");
    expect(motion(log("stale"), 1320).cancel?.dx).not.toBe(0);
    expect(motion(log("stale"), 1300 + 181).cancel?.dx).toBe(0);
    expect(sceneAt(fold(log("stale")), 1320, { reducedMotion: true }).cancel?.dx).toBe(0);
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
    expect(motion(log, 2400).hud.label).toBe("Click A");
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
    text: "Couldn't wait: the screen changed",
  });
});
