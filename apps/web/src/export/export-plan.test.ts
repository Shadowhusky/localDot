import { ulid } from "@localdot/protocol";
import { emptyModel } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { EXPORT_FPS, type ExportRequest, PRIVACY_NOTE, planExport } from "./export-plan.ts";

function fixture(endMs = 60_000) {
  const model = emptyModel();
  model.startT = 0;
  model.ended = { t: endMs, reason: "done" };
  const request: ExportRequest = {
    sessionId: ulid(),
    fromMs: 0,
    toMs: endMs,
    speed: 1,
    skipIdle: false,
    size: { w: 1280, h: 800 },
    captions: true,
  };
  return { model, request };
}

describe("deterministic MP4 export plan", () => {
  it("renders 30 frames per output second at the chosen speed", () => {
    const { model, request } = fixture();
    const plan = planExport({ ...request, speed: 4 }, model, [{ from: 0, to: 60_000_000 }], []);
    expect(EXPORT_FPS).toBe(30);
    expect(plan.frames).toBe(450);
    expect(plan.durationS).toBe(15);
    expect(plan.sessionMsAt(449)).toBeCloseTo(59_866.6667, 1);
  });

  it("compresses idle stretches when skipping idle and labels them", () => {
    const { model, request } = fixture(300_000);
    const plan = planExport(
      { ...request, skipIdle: true },
      model,
      [{ from: 0, to: 19_900_000 }],
      [],
    );
    expect(plan.frames).toBeLessThanOrEqual(30 * (20 + 0.4) + 1);
    expect(plan.frames).toBeGreaterThanOrEqual(600);
    expect(plan.labelAt(0)).toBeNull();
    expect(plan.labelAt(plan.frames - 1)).toBe("Idle skipped");
    let previous = -1;
    for (let frame = 0; frame < plan.frames; frame++) {
      expect(plan.sessionMsAt(frame)).toBeGreaterThanOrEqual(previous);
      previous = plan.sessionMsAt(frame);
    }
  });

  it.each([2, 4, 8] as const)("is honest at speed %s", (speed) => {
    const { model, request } = fixture();
    const plan = planExport({ ...request, speed }, model, [], []);
    for (let frame = 0; frame < plan.frames; frame++)
      expect(plan.labelAt(frame)).toBe(`Playing at ${speed}×`);
  });

  it("clips the requested range and refuses empty or invalid ranges", () => {
    const { model, request } = fixture();
    model.startT = 10_000;
    const plan = planExport({ ...request, fromMs: -100, toMs: 90_000 }, model, [], []);
    expect(plan.frames).toBe(1500);
    expect(plan.sessionMsAt(0)).toBe(10_000);
    expect(plan.sessionMsAt(plan.frames - 1)).toBeLessThan(60_000);
    for (const [fromMs, toMs] of [
      [60_000, 80_000],
      [20_000, 10_000],
      [0, 0],
      [0, Number.NaN],
      [Number.NEGATIVE_INFINITY, 10_000],
    ] as const)
      expect(() => planExport({ ...request, fromMs, toMs }, model, [], [])).toThrow(RangeError);
  });

  it("gives captions only within chapters and respects half-open gap boundaries", () => {
    const { model, request } = fixture();
    model.steps.push({ id: "read", kind: "browser", startT: 1000, endT: 5000, status: "ok" });
    const gaps = [{ from: 2_000_000, to: 4_000_000, reason: "user-control" as const }];
    const plan = planExport(request, model, [], gaps);
    expect(plan.captionAt(0)).toBeNull();
    expect(plan.captionAt(30)).toBe("Reading page");
    expect(plan.captionAt(150)).toBeNull();
    expect(plan.gapAt(59)).toBeNull();
    expect(plan.gapAt(60)).toBe("user-control");
    expect(plan.gapAt(119)).toBe("user-control");
    expect(plan.gapAt(120)).toBeNull();
    expect(planExport({ ...request, captions: false }, model, [], gaps).captionAt(30)).toBeNull();
  });

  it("prioritizes takeover over other overlapping gaps and handles open-ended gaps", () => {
    const { model, request } = fixture();
    const plan = planExport(
      request,
      model,
      [],
      [
        { from: 0, to: null, reason: "disk-full" },
        { from: 1_000_000, to: 2_000_000, reason: "user-control" },
      ],
    );
    expect(plan.gapAt(0)).toBe("disk-full");
    expect(plan.gapAt(30)).toBe("user-control");
    expect(plan.gapAt(60)).toBe("disk-full");
  });

  it("clips a live export to the latest known history or recording activity", () => {
    const { model, request } = fixture();
    model.ended = null;
    model.agentStates.push({ state: "thinking", t: 10_000 });
    const plan = planExport(request, model, [{ from: 0, to: 20_000_000 }], []);
    expect(plan.frames).toBe(600);
    expect(plan.sessionMsAt(plan.frames - 1)).toBeLessThan(20_000);
  });

  it("rejects malformed export parameters and out-of-range frame indexes", () => {
    const { model, request } = fixture();
    for (const patch of [{ speed: 3 }, { size: { w: 1279, h: 800 } }, { sessionId: "../other" }])
      expect(() => planExport({ ...request, ...patch } as ExportRequest, model, [], [])).toThrow(
        RangeError,
      );
    const plan = planExport(request, model, [], []);
    for (const frame of [-1, 0.5, plan.frames, Number.NaN])
      expect(() => plan.sessionMsAt(frame)).toThrow(RangeError);
  });

  it("keeps the required privacy note verbatim", () => {
    expect(PRIVACY_NOTE).toBe(
      "This video shows everything on the computer's screen in the range you chose. Fields marked secret appear as dots. Stretches where you had control were never recorded.",
    );
  });
});
