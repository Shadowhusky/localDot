import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { emptyModel, foldEvents, startedCount } from "./model.ts";
import { sceneAt } from "./scene.ts";

// A dense 2-hour session as M4 will log it: a GUI step every ~500 ms, every fourth one typing with
// per-character progress, thinking pauses, every tenth step cancelled: about 138 000 events.
function twoHourLog(): LocalDotEvent[] {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const out: LocalDotEvent[] = [];
  const ev = (type: string, tMs: number, data: Record<string, unknown>, step?: string) =>
    out.push({
      v: 1,
      id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
      seq: out.length,
      t: msToMicros(tMs),
      agent: "main",
      ...(step ? { step } : {}),
      type,
      data,
    } as LocalDotEvent);
  ev("session.start", 0, { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title: "long" });
  let t = 100;
  let from = { x: 200, y: 200 };
  for (let n = 0; t < 7_200_000; n++) {
    const step = `s${n}`;
    const to = { x: 100 + Math.floor(rnd() * 2300), y: 100 + Math.floor(rnd() * 1400) };
    const typing = n % 4 === 0;
    ev("agent.state", t, { state: "acting" });
    ev("step.start", t, { kind: "gui" }, step);
    ev(
      "action.intent",
      t + 1,
      {
        verb: typing ? "type" : "click",
        label: typing ? 'Type "hello world"' : "Click A",
        point: to,
        risk: "none",
        pointer: { from, to, startsAt: t + 121, durationMs: 300, seed: n, curve: "minjerk-bow-v1" },
      },
      step,
    );
    ev(
      "action.target",
      t + 150,
      {
        target: {
          point: to,
          bbox: { x: to.x - 20, y: to.y - 10, w: 40, h: 20 },
          source: "ax",
          role: "button",
          name: "A",
        },
      },
      step,
    );
    if (n % 10 === 9) {
      ev("action.cancel", t + 300, { reason: "stale" }, step);
      ev("step.end", t + 301, { status: "failed" }, step);
    } else {
      const press = t + 520;
      const input = typing
        ? { kind: "type", chars: 11, masked: false }
        : { kind: "click", button: "left", count: 1, at: to };
      ev(
        "action.dispatch",
        press + 2,
        { input, pressT: msToMicros(press), ringAt: msToMicros(press + 23), injector: "xtest" },
        step,
      );
      if (typing)
        for (let c = 1; c <= 11; c++)
          ev(
            "text.progress",
            press + c * 35,
            { count: c, chunk: "hello world"[c - 1], masked: false },
            step,
          );
      ev(
        "screen.settle",
        press + 300,
        { frameT: msToMicros(press + 30), changed: [], noVisibleChange: false },
        step,
      );
      ev(
        "observe",
        press + 330,
        { frameId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N", width: 1280, height: 800 },
        step,
      );
      ev("action.result", press + 340, { ok: true }, step);
      ev("step.end", press + 341, { status: "ok" }, step);
    }
    from = to;
    t += 450 + Math.floor(rnd() * 100);
    if (n % 50 === 49) {
      ev("agent.state", t, { state: "thinking" });
      t += 5000;
    }
  }
  ev("session.end", t, { reason: "done" });
  return out;
}

describe("a 2-hour session (Review Focus 4, the stage)", () => {
  const log = twoHourLog();

  it("folds in under 2 s and indexes every action", () => {
    const started = performance.now();
    const model = foldEvents(emptyModel(), log);
    const foldMs = performance.now() - started;
    console.info(
      JSON.stringify({
        case: "two-hour-fold",
        foldMs,
        events: log.length,
        actions: model.actions.length,
      }),
    );
    expect(foldMs).toBeLessThan(2000);
    expect(log.length).toBeGreaterThan(100_000);
    expect(model.actions.length).toBeGreaterThan(11_000);
    for (const t of [0, 99, 100, 101, 3_600_000, 7_300_000]) {
      expect(startedCount(model, t)).toBe(model.actions.filter((a) => a.intentT <= t).length);
    }
  });

  it("a 2-hour session scene costs under 0.2 ms and equals the unbounded scene", () => {
    const model = foldEvents(emptyModel(), log);
    const end = model.ended?.t ?? 0;
    const view = { reducedMotion: false };
    let seed = 11;
    const times = Array.from({ length: 10_000 }, () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return (seed / 2_147_483_647) * end;
    });
    const started = performance.now();
    for (const t of times) sceneAt(model, t, view);
    const meanSceneMs = (performance.now() - started) / times.length;
    console.info(
      JSON.stringify({
        case: "two-hour-scene",
        meanSceneMs,
        samples: times.length,
        unboundedComparisons: 2000,
      }),
    );
    expect(meanSceneMs).toBeLessThan(0.2);
    for (const t of times.slice(0, 2000)) {
      expect(sceneAt(model, t, view)).toEqual(
        sceneAt(model, t, view, { ringLookback: Number.POSITIVE_INFINITY }),
      );
    }
  });
});
