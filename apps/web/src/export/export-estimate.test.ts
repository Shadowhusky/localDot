// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  calibrationFrom,
  estimateExport,
  keepCalibration,
  storedCalibration,
  UNCALIBRATED,
  waitText,
} from "./export-estimate.ts";
import { type ExportFrameRate, exportBitrate } from "./export-plan.ts";

// Two minutes of a seeded recording in which something moves for 56 s (lane L13's measurement).
function twoMinutes(fps: ExportFrameRate, size: { w: number; h: number }, quality: "low" | "high") {
  return {
    plan: {
      frames: 120 * fps,
      fps,
      durationS: 120,
      movingS: 56.4,
      bitrate: exportBitrate(size, fps, quality),
    },
    request: { size, format: "mp4" as const, quality },
  };
}

afterEach(() => localStorage.clear());

describe("an export's estimate", () => {
  it("is within reach of what Chrome made for Quality and Fast", () => {
    const quality = twoMinutes(60, { w: 2560, h: 1600 }, "high");
    const fast = twoMinutes(15, { w: 1280, h: 800 }, "low");
    const big = estimateExport(quality.plan, quality.request);
    const small = estimateExport(fast.plan, fast.request);
    // Measured: Quality 13.1 MB in 5.9 s, Fast 1.7 MB in 1.4 s.
    expect(big.bytes / 2 ** 20).toBeGreaterThan(13.1 / 2);
    expect(big.bytes / 2 ** 20).toBeLessThan(13.1 * 2);
    expect(big.ms).toBeGreaterThan(5900 / 2);
    expect(big.ms).toBeLessThan(5900 * 2);
    expect(small.bytes / 2 ** 20).toBeGreaterThan(1.7 / 2);
    expect(small.bytes / 2 ** 20).toBeLessThan(1.7 * 2);
    expect(small.ms).toBeGreaterThan(1400 / 2);
    expect(small.ms).toBeLessThan(1400 * 2);
  });

  it("takes longer for WebM and scales by this browser's calibration", () => {
    const { plan, request } = twoMinutes(30, { w: 1920, h: 1200 }, "high");
    const mp4 = estimateExport(plan, request);
    expect(estimateExport(plan, { ...request, format: "webm" }).ms).toBeGreaterThan(2.5 * mp4.ms);
    const slow = estimateExport(plan, request, { time: 2, size: 0.5 });
    expect(slow.ms).toBeCloseTo(2 * mp4.ms);
    expect(slow.bytes).toBeCloseTo(0.5 * mp4.bytes);
  });
});

describe("an export with dot", () => {
  it("makes every frame a new picture, and pays for dot's motion through the whole video", () => {
    const { plan, request } = twoMinutes(60, { w: 1920, h: 1410 }, "high");
    const clean = estimateExport(plan, request);
    const withDot = estimateExport(plan, { ...request, dot: "under" });
    const pictures = 0.45 * plan.movingS * plan.fps + plan.durationS;
    expect((withDot.ms - 200) / (clean.ms - 200)).toBeCloseTo(plan.frames / pictures, 5);
    expect(withDot.bytes - clean.bytes).toBeCloseTo((plan.bitrate / 8) * 120 * 0.075, 0);
  });

  it("is within reach of what Chrome made for Showcase", () => {
    // Measured: 1:38 of video at 1920 × 1410 and 60 fps, moving for 86 s: 25.6 MB in 19.0 s.
    const plan = {
      frames: 5832,
      fps: 60 as const,
      durationS: 97.2,
      movingS: 86,
      bitrate: exportBitrate({ w: 1920, h: 1410 }, 60, "high"),
    };
    const made = estimateExport(plan, {
      size: { w: 1920, h: 1410 },
      format: "mp4",
      quality: "high",
      dot: "under",
    });
    expect(made.bytes / 2 ** 20).toBeGreaterThan(25.6 / 1.5);
    expect(made.bytes / 2 ** 20).toBeLessThan(25.6 * 1.5);
    expect(made.ms).toBeGreaterThan(19_000 / 1.5);
    expect(made.ms).toBeLessThan(19_000 * 1.5);
  });
});

describe("calibration", () => {
  it("learns from an export long enough to tell, within bounds", () => {
    const fitted = { bytes: 4_000_000, ms: 4000 };
    expect(calibrationFrom(fitted, { bytes: 2_000_000, ms: 6000 }, UNCALIBRATED)).toEqual({
      time: 1.5,
      size: 0.5,
    });
    expect(calibrationFrom(fitted, { bytes: 1, ms: 60_000 }, UNCALIBRATED)).toEqual({
      time: 4,
      size: 0.25,
    });
    const previous = { time: 1.2, size: 0.8 };
    expect(calibrationFrom({ bytes: 1000, ms: 300 }, { bytes: 9000, ms: 900 }, previous)).toEqual(
      previous,
    );
  });

  it("is kept for this browser and read back defensively", () => {
    expect(storedCalibration()).toEqual(UNCALIBRATED);
    keepCalibration({ time: 1.5, size: 0.5 });
    expect(storedCalibration()).toEqual({ time: 1.5, size: 0.5 });
    localStorage.setItem("localdot.export-calibration.v1", '{"time":99,"size":"x"}');
    expect(storedCalibration()).toEqual(UNCALIBRATED);
  });
});

describe("a wait in words", () => {
  it("rounds to what a person would say", () => {
    expect(waitText(1200)).toBe("a few seconds");
    expect(waitText(6100)).toBe("about 5 s");
    expect(waitText(13_000)).toBe("about 15 s");
    expect(waitText(80_000)).toBe("about 1 min");
    expect(waitText(150_000)).toBe("about 3 min");
  });
});
