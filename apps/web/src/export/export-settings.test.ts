import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHOICES,
  type ExportEnvironment,
  exportRequest,
  fitOptions,
  hostEncodable,
  maxFrameRate,
  optionsFor,
  parseChoices,
  parseSpeed,
  presetOptions,
  sizeOf,
  sourceSize,
  stepSpeed,
  UNKNOWN_ENVIRONMENT,
  withOption,
} from "./export-settings.ts";

const SCREEN: ExportEnvironment = {
  source: { w: 2560, h: 1600 },
  sourceRate: 60,
  encodable: {
    mp4: { "480p": true, "720p": true, "1080p": true, source: true },
    webm: { "480p": true, "720p": true, "1080p": true, source: false },
  },
};

describe("presets", () => {
  it("makes Quality at the computer's own size and 60 fps when the recording has it", () => {
    expect(presetOptions("quality", SCREEN, 1)).toEqual({
      size: "source",
      fps: 60,
      quality: "high",
      format: "mp4",
    });
    expect(sizeOf("source", SCREEN)).toEqual({ w: 2560, h: 1600 });
  });

  it("drops Quality to 1080p where the browser cannot encode the full size", () => {
    const env = { ...SCREEN, encodable: { ...SCREEN.encodable, mp4: { source: false } } };
    expect(presetOptions("quality", env, 1).size).toBe("1080p");
  });

  it("keeps Quality to the recording's own frame rate", () => {
    expect(presetOptions("quality", { ...SCREEN, sourceRate: 30 }, 1).fps).toBe(30);
    expect(presetOptions("quality", { ...SCREEN, sourceRate: 24 }, 1).fps).toBe(24);
  });

  it("makes Fast small: 720p at 15 fps and a low rate, or the recording's size when smaller", () => {
    expect(presetOptions("fast", SCREEN, 1)).toEqual({
      size: "720p",
      fps: 15,
      quality: "low",
      format: "mp4",
    });
    const small = { ...SCREEN, source: { w: 1024, h: 640 } };
    expect(presetOptions("fast", small, 1).size).toBe("source");
    expect(sizeOf("source", small)).toEqual({ w: 1024, h: 640 });
    expect(presetOptions("fast", { ...SCREEN, sourceRate: 10 }, 1).fps).toBe(10);
  });

  it("fits a larger screen inside the largest export, keeping its shape and even sides", () => {
    expect(sourceSize({ w: 3840, h: 2160 })).toEqual({ w: 2560, h: 1440 });
    expect(sourceSize({ w: 2880, h: 1800 })).toEqual({ w: 2560, h: 1600 });
    expect(sourceSize({ w: 1001, h: 627 })).toEqual({ w: 1002, h: 628 });
    expect(sizeOf("source", UNKNOWN_ENVIRONMENT)).toEqual({ w: 1920, h: 1200 });
  });
});

describe("frame rate", () => {
  it("is capped by the recording, which has more new pictures a second when sped up", () => {
    expect(maxFrameRate({ ...SCREEN, sourceRate: 30 }, 1)).toBe(30);
    expect(maxFrameRate({ ...SCREEN, sourceRate: 30 }, 2)).toBe(60);
    expect(maxFrameRate({ ...SCREEN, sourceRate: 25 }, 1)).toBe(24);
    expect(maxFrameRate({ ...SCREEN, sourceRate: 30 }, 0.5)).toBe(30);
    expect(maxFrameRate({ ...SCREEN, sourceRate: 5 }, 1)).toBe(10);
    expect(maxFrameRate(UNKNOWN_ENVIRONMENT, 1)).toBe(60);
  });
});

describe("advanced values", () => {
  it("turn a preset into Custom, and back when they match a preset again", () => {
    const quality = { ...DEFAULT_CHOICES, preset: "quality" as const };
    const custom = withOption(quality, SCREEN, { fps: 30 });
    expect(custom.preset).toBe("custom");
    expect(optionsFor(custom, SCREEN)).toEqual({
      size: "source",
      fps: 30,
      quality: "high",
      format: "mp4",
    });
    expect(withOption(custom, SCREEN, { fps: 60 }).preset).toBe("quality");
    const fast = withOption(custom, SCREEN, { size: "720p", fps: 15, quality: "low" });
    expect(fast.preset).toBe("fast");
  });

  it("become the nearest this recording and browser can make", () => {
    const env = { ...SCREEN, sourceRate: 30 };
    expect(
      fitOptions({ size: "source", fps: 60, quality: "high", format: "webm" }, env, 1),
    ).toEqual({ size: "source", fps: 30, quality: "high", format: "mp4" });
    const noFull = { ...SCREEN, encodable: { ...SCREEN.encodable, mp4: { source: false } } };
    expect(
      fitOptions({ size: "source", fps: 30, quality: "low", format: "mp4" }, noFull, 1).size,
    ).toBe("1080p");
  });

  it("make the request the worker is given", () => {
    const choices = { ...DEFAULT_CHOICES, preset: "fast" as const, speed: 3, overlays: false };
    expect(exportRequest("S", { fromMs: 5, toMs: 50 }, choices, SCREEN)).toEqual({
      sessionId: "S",
      fromMs: 5,
      toMs: 50,
      speed: 3,
      skipIdle: true,
      captions: true,
      overlays: false,
      size: { w: 1280, h: 800 },
      fps: 15,
      quality: "low",
      format: "mp4",
    });
  });
});

describe("speed", () => {
  it("steps through the usual speeds, and from any typed speed to the next one", () => {
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(3, 1)).toBe(4);
    expect(stepSpeed(2.2, 1)).toBe(2.5);
    expect(stepSpeed(2.2, -1)).toBe(2);
    expect(stepSpeed(16, 1)).toBe(16);
    expect(stepSpeed(0.25, -1)).toBe(0.25);
  });

  it("reads a typed speed, kept between a quarter and sixteen", () => {
    expect(parseSpeed("2.5")).toBe(2.5);
    expect(parseSpeed(" 3x ")).toBe(3);
    expect(parseSpeed("1,5×")).toBe(1.5);
    expect(parseSpeed(".5")).toBe(0.5);
    expect(parseSpeed("40")).toBe(16);
    expect(parseSpeed("0.1")).toBe(0.25);
    expect(parseSpeed("1.239")).toBe(1.24);
    for (const text of ["", "fast", "0", "-2", "2..5"]) expect(parseSpeed(text)).toBeNull();
  });
});

describe("remembered choices", () => {
  it("come back as they were kept", () => {
    const kept = {
      ...DEFAULT_CHOICES,
      preset: "custom" as const,
      custom: {
        size: "720p" as const,
        fps: 24 as const,
        quality: "low" as const,
        format: "webm" as const,
      },
      speed: 2.5,
      captions: false,
    };
    expect(parseChoices(JSON.stringify(kept))).toEqual(kept);
  });

  it("fall back value by value when missing or damaged", () => {
    expect(parseChoices(null)).toEqual(DEFAULT_CHOICES);
    expect(parseChoices("{not json")).toEqual(DEFAULT_CHOICES);
    expect(
      parseChoices(JSON.stringify({ preset: "fast", speed: 99, custom: { fps: 25, size: "4k" } })),
    ).toEqual({ ...DEFAULT_CHOICES, preset: "fast" });
  });
});

describe("what the host can make", () => {
  it("allows every size up to the largest picture the host encodes in each format", () => {
    expect(hostEncodable(SCREEN, { mp4: 2560 * 1600, webm: 1280 * 800 })).toEqual({
      mp4: { "480p": true, "720p": true, "1080p": true, source: true },
      webm: { "480p": true, "720p": true, "1080p": false, source: false },
    });
  });
});
