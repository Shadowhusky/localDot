import { ulid } from "@localdot/protocol";
import { emptyModel } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import {
  EXPORT_FRAME_RATES,
  type ExportRequest,
  exportBitrate,
  fileSize,
  PRIVACY_NOTE,
  planExport,
  speedText,
  validSize,
  videoLength,
} from "./export-plan.ts";

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
    overlays: true,
    fps: 30,
    quality: "high",
    format: "mp4",
  };
  return { model, request };
}

describe("deterministic MP4 export plan", () => {
  it("renders 30 frames per output second at the chosen speed", () => {
    const { model, request } = fixture();
    const plan = planExport({ ...request, speed: 4 }, model, [{ from: 0, to: 60_000_000 }], []);
    expect(plan.frames).toBe(450);
    expect(plan.durationS).toBe(15);
    expect(plan.sessionMsAt(449)).toBeCloseTo(59_866.6667, 1);
  });

  it.each(EXPORT_FRAME_RATES)("samples session time evenly at %s fps", (fps) => {
    const { model, request } = fixture();
    const plan = planExport({ ...request, fps }, model, [], []);
    expect(plan.fps).toBe(fps);
    expect(plan.frames).toBe(60 * fps);
    expect(plan.durationS).toBe(60);
    for (const frame of [0, 1, fps, plan.frames - 1])
      expect(plan.sessionMsAt(frame)).toBeCloseTo((frame * 1000) / fps, 6);
  });

  it("maps any speed from a quarter to sixteen times onto session time, so 3× stays smooth", () => {
    const { model, request } = fixture();
    const three = planExport({ ...request, speed: 3, fps: 60 }, model, [], []);
    expect(three.frames).toBe(1200);
    expect(three.durationS).toBe(20);
    // Every frame moves on by the same 50 ms of session time: no frame repeats, none jumps.
    for (let frame = 1; frame < three.frames; frame++)
      expect(three.sessionMsAt(frame) - three.sessionMsAt(frame - 1)).toBeCloseTo(50, 6);
    const odd = planExport({ ...request, speed: 2.5 }, model, [], []);
    expect(odd.frames).toBe(720);
    expect(planExport({ ...request, speed: 0.25 }, model, [], []).frames).toBe(7200);
    expect(planExport({ ...request, speed: 16 }, model, [], []).frames).toBe(113);
    for (const speed of [0.2, 16.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => planExport({ ...request, speed }, model, [], [])).toThrow(RangeError);
  });

  it("names speeds plainly", () => {
    expect(speedText(2)).toBe("2×");
    expect(speedText(0.25)).toBe("0.25×");
    expect(speedText(1.333333)).toBe("1.33×");
  });

  it("counts the moving part of the video at its speed", () => {
    const { model, request } = fixture();
    const activity = [
      { from: 10_000_000, to: 12_000_000 },
      { from: 40_000_000, to: 41_000_000 },
    ];
    const once = planExport(request, model, activity, []);
    const twice = planExport({ ...request, speed: 2 }, model, activity, []);
    expect(once.movingS).toBeGreaterThan(3);
    expect(once.movingS).toBeLessThan(10);
    expect(twice.movingS).toBeCloseTo(once.movingS / 2, 6);
    expect(planExport(request, model, [{ from: 0, to: 90_000_000 }], []).movingS).toBe(60);
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
    let previous = -1;
    for (let frame = 0; frame < plan.frames; frame++) {
      expect(plan.sessionMsAt(frame)).toBeGreaterThanOrEqual(previous);
      previous = plan.sessionMsAt(frame);
    }
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

  it("asks the encoder for more bits as the picture, the frame rate and the quality grow", () => {
    const small = { w: 1280, h: 800 };
    const large = { w: 2560, h: 1600 };
    expect(exportBitrate(large, 30, "high")).toBeGreaterThan(
      3.5 * exportBitrate(small, 30, "high"),
    );
    expect(exportBitrate(small, 60, "high")).toBeGreaterThan(exportBitrate(small, 30, "high"));
    expect(exportBitrate(small, 60, "high")).toBeLessThan(2 * exportBitrate(small, 30, "high"));
    expect(exportBitrate(small, 30, "medium")).toBeGreaterThan(exportBitrate(small, 30, "low"));
    expect(exportBitrate(large, 60, "high") / 1e6).toBeCloseTo(12.1, 0);
    expect(exportBitrate({ w: 16, h: 16 }, 10, "low")).toBe(200_000);
  });

  it("takes any even size up to the computer's own screen", () => {
    for (const size of [
      { w: 2560, h: 1600 },
      { w: 320, h: 192 },
      { w: 1600, h: 2560 },
    ])
      expect(validSize(size)).toBe(true);
    for (const size of [
      { w: 2562, h: 1600 },
      { w: 2560, h: 1602 },
      { w: 1279, h: 800 },
      { w: 8, h: 8 },
      { w: 2560.5, h: 1600 },
    ])
      expect(validSize(size)).toBe(false);
  });

  it("writes sizes and lengths plainly", () => {
    expect(fileSize(2048)).toBe("2 KB");
    expect(fileSize(3.25 * 1024 * 1024)).toBe("3.3 MB");
    expect(fileSize(78.4 * 1024 * 1024)).toBe("78 MB");
    expect(videoLength(0.6)).toBe("0:01");
    expect(videoLength(97.2)).toBe("1:38");
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
    for (const patch of [
      { speed: 32 },
      { size: { w: 1279, h: 800 } },
      { sessionId: "../other" },
      { fps: 25 },
      { quality: "best" },
      { format: "mov" },
    ])
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
