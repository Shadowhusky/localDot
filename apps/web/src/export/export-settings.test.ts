import { describe, expect, it } from "vitest";
import {
  choosePreset,
  DEFAULT_CHOICES,
  type ExportEnvironment,
  type ExportOptions,
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
  encodable: { mp4: {}, webm: { "2560x1600": false } },
};
const CLEAN = { format: "mp4", dot: "off", captions: false } as const;
const options = (o: Pick<ExportOptions, "size" | "fps" | "quality">): ExportOptions => ({
  ...CLEAN,
  ...o,
});

describe("presets", () => {
  it("makes Quality at the computer's own size and 60 fps when the recording has it", () => {
    expect(presetOptions("quality", SCREEN, 1)).toEqual(
      options({ size: "source", fps: 60, quality: "high" }),
    );
    expect(sizeOf("source", SCREEN)).toEqual({ w: 2560, h: 1600 });
  });

  it("drops Quality to 1080p where the browser cannot encode the full size", () => {
    const env = { ...SCREEN, encodable: { ...SCREEN.encodable, mp4: { "2560x1600": false } } };
    expect(presetOptions("quality", env, 1).size).toBe("1080p");
  });

  it("keeps Quality to the recording's own frame rate", () => {
    expect(presetOptions("quality", { ...SCREEN, sourceRate: 30 }, 1).fps).toBe(30);
    expect(presetOptions("quality", { ...SCREEN, sourceRate: 24 }, 1).fps).toBe(24);
  });

  it("makes Fast small: 720p at 15 fps and a low rate, or the recording's size when smaller", () => {
    expect(presetOptions("fast", SCREEN, 1)).toEqual(
      options({ size: "720p", fps: 15, quality: "low" }),
    );
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

describe("Showcase and dot", () => {
  it("puts dot under a 1080p picture, smooth at the recording's own 30 or 60 fps", () => {
    expect(presetOptions("showcase", SCREEN, 1)).toEqual({
      ...options({ size: "1080p", fps: 60, quality: "high" }),
      dot: "under",
    });
    expect(presetOptions("showcase", { ...SCREEN, sourceRate: 30 }, 1).fps).toBe(30);
    expect(presetOptions("showcase", { ...SCREEN, sourceRate: 50 }, 1).fps).toBe(30);
    expect(presetOptions("showcase", { ...SCREEN, sourceRate: 15 }, 1).fps).toBe(15);
  });

  it("keeps Quality and Fast clean: no dot and no step caption", () => {
    for (const preset of ["quality", "fast"] as const) {
      const made = presetOptions(preset, SCREEN, 1);
      expect([made.dot, made.captions]).toEqual(["off", false]);
    }
  });

  it("plays the recording at its own pace with the waits left out when Showcase is chosen", () => {
    const fast = { ...DEFAULT_CHOICES, preset: "fast" as const, speed: 3, skipIdle: false };
    expect(choosePreset(fast, "showcase")).toEqual({
      ...fast,
      preset: "showcase",
      speed: 1,
      skipIdle: true,
    });
    expect(choosePreset(fast, "quality")).toEqual({ ...fast, preset: "quality" });
  });

  it("grows the video by dot's band, and fits Original with its band in the largest export", () => {
    expect(sizeOf("1080p", SCREEN, "under")).toEqual({ w: 1920, h: 1410 });
    expect(sizeOf("1080p", SCREEN, "over")).toEqual({ w: 1920, h: 1200 });
    expect(sizeOf("720p", SCREEN, "under")).toEqual({ w: 1280, h: 940 });
    const original = sizeOf("source", SCREEN, "under");
    expect(original).toEqual({ w: 2362, h: 1734 });
    expect(original.w * original.h).toBeLessThanOrEqual(2560 * 1600);
    expect(sourceSize({ w: 2560, h: 1600 }, true)).toEqual({ w: 2362, h: 1476 });
    expect(sizeOf("source", { ...SCREEN, source: { w: 1280, h: 800 } }, "under")).toEqual({
      w: 1280,
      h: 940,
    });
  });

  it("drops Showcase to 720p where the browser can't make 1080p with the band", () => {
    const env = { ...SCREEN, encodable: { ...SCREEN.encodable, mp4: { "1920x1410": false } } };
    expect(presetOptions("showcase", env, 1).size).toBe("720p");
    expect(presetOptions("quality", env, 1).size).toBe("source");
  });

  it("turns a preset into Custom when dot or the caption changes, and back", () => {
    const quality = { ...DEFAULT_CHOICES, preset: "quality" as const };
    const withDot = withOption(quality, SCREEN, { dot: "over" });
    expect(withDot.preset).toBe("custom");
    expect(withDot.custom.dot).toBe("over");
    expect(withOption(withDot, SCREEN, { dot: "off" }).preset).toBe("quality");
    const showcase = { ...DEFAULT_CHOICES, preset: "showcase" as const };
    expect(withOption(showcase, SCREEN, { captions: true }).preset).toBe("custom");
  });

  it("asks for dot only when it is shown, with the band in the video's size", () => {
    const showcase = { ...DEFAULT_CHOICES, preset: "showcase" as const };
    const request = exportRequest("S", { fromMs: 0, toMs: 9 }, showcase, SCREEN);
    expect(request).toMatchObject({ dot: "under", size: { w: 1920, h: 1410 }, fps: 60 });
    const clean = exportRequest("S", { fromMs: 0, toMs: 9 }, DEFAULT_CHOICES, SCREEN);
    expect("dot" in clean).toBe(false);
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
    expect(optionsFor(custom, SCREEN)).toEqual(
      options({ size: "source", fps: 30, quality: "high" }),
    );
    expect(withOption(custom, SCREEN, { fps: 60 }).preset).toBe("quality");
    const fast = withOption(custom, SCREEN, { size: "720p", fps: 15, quality: "low" });
    expect(fast.preset).toBe("fast");
  });

  it("become the nearest this recording and browser can make", () => {
    const env = { ...SCREEN, sourceRate: 30 };
    expect(
      fitOptions(
        { ...options({ size: "source", fps: 60, quality: "high" }), format: "webm" },
        env,
        1,
      ),
    ).toEqual(options({ size: "source", fps: 30, quality: "high" }));
    const noFull = { ...SCREEN, encodable: { ...SCREEN.encodable, mp4: { "2560x1600": false } } };
    expect(fitOptions(options({ size: "source", fps: 30, quality: "low" }), noFull, 1).size).toBe(
      "1080p",
    );
  });

  it("make the request the worker is given", () => {
    const choices = { ...DEFAULT_CHOICES, preset: "fast" as const, speed: 3, overlays: false };
    expect(exportRequest("S", { fromMs: 5, toMs: 50 }, choices, SCREEN)).toEqual({
      sessionId: "S",
      fromMs: 5,
      toMs: 50,
      speed: 3,
      skipIdle: true,
      captions: false,
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
        dot: "over" as const,
        captions: true,
      },
      place: "over" as const,
      speed: 2.5,
    };
    expect(parseChoices(JSON.stringify(kept))).toEqual(kept);
  });

  it("keep a step caption chosen before presets set it, for Custom", () => {
    const old = { preset: "custom", custom: { size: "720p" }, captions: true, skipIdle: false };
    expect(parseChoices(JSON.stringify(old))).toEqual({
      ...DEFAULT_CHOICES,
      preset: "custom",
      custom: { ...DEFAULT_CHOICES.custom, size: "720p", captions: true },
      skipIdle: false,
    });
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
    expect(hostEncodable(SCREEN, { mp4: 2560 * 1600, webm: 1280 * 940 })).toEqual({
      mp4: {
        "768x480": true,
        "768x564": true,
        "1280x800": true,
        "1280x940": true,
        "1920x1200": true,
        "1920x1410": true,
        "2560x1600": true,
        "2362x1734": true,
      },
      webm: {
        "768x480": true,
        "768x564": true,
        "1280x800": true,
        "1280x940": true,
        "1920x1200": false,
        "1920x1410": false,
        "2560x1600": false,
        "2362x1734": false,
      },
    });
  });
});
