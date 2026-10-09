import { DOT_PLACEMENTS, type DotPlacement } from "@localdot/protocol";
import { withBand } from "./dot-band.ts";
import {
  EXPORT_FORMATS,
  EXPORT_FRAME_RATES,
  EXPORT_QUALITIES,
  type ExportFormat,
  type ExportFrameRate,
  type ExportQuality,
  type ExportRequest,
  type ExportSize,
  MAX_EXPORT_SIZE,
  SPEED_LIMITS,
  validSize,
  validSpeed,
} from "./export-plan.ts";

export const SIZE_CHOICES = ["480p", "720p", "1080p", "source"] as const;
export type SizeChoice = (typeof SIZE_CHOICES)[number];
const FIXED_SIZES: Record<Exclude<SizeChoice, "source">, ExportSize> = {
  "480p": { w: 768, h: 480 },
  "720p": { w: 1280, h: 800 },
  "1080p": { w: 1920, h: 1200 },
};

export const PRESETS = ["quality", "fast", "showcase"] as const;
export type ExportPreset = (typeof PRESETS)[number];
export type PresetChoice = ExportPreset | "custom";
export type DotChoice = "off" | DotPlacement;

// What the presets set; the rest of the choices are kept across them.
export interface ExportOptions {
  size: SizeChoice;
  fps: ExportFrameRate;
  quality: ExportQuality;
  format: ExportFormat;
  dot: DotChoice;
  captions: boolean;
}

export interface ExportChoices {
  preset: PresetChoice;
  // The viewer's own values, used while the preset is custom.
  custom: ExportOptions;
  // Where dot goes when the viewer turns it on.
  place: DotPlacement;
  speed: number;
  skipIdle: boolean;
  overlays: boolean;
  // Whether a dragged trim handle stops at the edges of dot's steps.
  snap: boolean;
}

// What this recording and this browser allow. Unknown (null) allows, so nothing is held back while
// the checks run.
export interface ExportEnvironment {
  // The recording's own picture size.
  source: ExportSize | null;
  // Frames per second the recording was made at, while things moved on the screen.
  sourceRate: number | null;
  // Whether a video of each size ("1920x1200") can be made, by format.
  encodable: Record<ExportFormat, Record<string, boolean>>;
}

export const UNKNOWN_ENVIRONMENT: ExportEnvironment = {
  source: null,
  sourceRate: null,
  encodable: { mp4: {}, webm: {} },
};

export const DEFAULT_CHOICES: ExportChoices = {
  preset: "quality",
  custom: {
    size: "1080p",
    fps: 30,
    quality: "medium",
    format: "mp4",
    dot: "off",
    captions: false,
  },
  place: "under",
  speed: 1,
  skipIdle: true,
  overlays: true,
  snap: true,
};

export const sizeKey = (size: ExportSize) => `${size.w}x${size.h}`;

// Every size a video of this recording can have: each choice, with and without dot's band.
export function videoSizes(env: ExportEnvironment): ExportSize[] {
  const sizes = new Map<string, ExportSize>();
  for (const choice of SIZE_CHOICES)
    for (const dot of ["off", "under"] as const) {
      const size = sizeOf(choice, env, dot);
      sizes.set(sizeKey(size), size);
    }
  return [...sizes.values()];
}

// What the host can make: every size up to the largest picture it encodes in each format.
export function hostEncodable(
  env: ExportEnvironment,
  maxPixels: Record<ExportFormat, number>,
): ExportEnvironment["encodable"] {
  const fits = (format: ExportFormat) =>
    Object.fromEntries(
      videoSizes(env).map((size) => [sizeKey(size), size.w * size.h <= maxPixels[format]]),
    );
  return { mp4: fits("mp4"), webm: fits("webm") };
}

const even = (value: number) => Math.max(16, 2 * Math.round(value / 2));

// The recording's own size, made smaller to fit the largest export when it is bigger, band and all.
export function sourceSize(source: ExportSize, band = false): ExportSize {
  const total = (size: ExportSize) => (band ? withBand(size) : size);
  const whole = total(source);
  let scale = Math.min(
    1,
    MAX_EXPORT_SIZE.w / source.w,
    MAX_EXPORT_SIZE.h / source.h,
    Math.sqrt((MAX_EXPORT_SIZE.w * MAX_EXPORT_SIZE.h) / (whole.w * whole.h)),
  );
  let size = { w: even(source.w * scale), h: even(source.h * scale) };
  while (!validSize(total(size)) && size.w > 16) {
    scale *= 0.995;
    size = { w: even(source.w * scale), h: even(source.h * scale) };
  }
  return size;
}

// The video's whole size: the picture, and dot's band under it when it has one.
export function sizeOf(
  choice: SizeChoice,
  env: ExportEnvironment,
  dot: DotChoice = "off",
): ExportSize {
  const band = dot === "under";
  const picture =
    choice !== "source"
      ? FIXED_SIZES[choice]
      : env.source
        ? sourceSize(env.source, band)
        : FIXED_SIZES["1080p"];
  return band ? withBand(picture) : picture;
}

export function sizeLabel(choice: SizeChoice): string {
  return choice === "source" ? "Original" : choice;
}

// Whether this size can be made in this format, as far as is known yet.
export function encodable(
  env: ExportEnvironment,
  format: ExportFormat,
  size: SizeChoice,
  dot: DotChoice = "off",
): boolean | undefined {
  return env.encodable[format][sizeKey(sizeOf(size, env, dot))];
}

const encodes = (env: ExportEnvironment, format: ExportFormat, size: SizeChoice, dot: DotChoice) =>
  encodable(env, format, size, dot) !== false;

// The fastest frame rate worth making: one the recording has new pictures for. At 2× a 30 fps
// recording has 60 new pictures every second of video; slowed down, dot's pointer still moves at the
// recording's own rate.
export function maxFrameRate(env: ExportEnvironment, speed: number): ExportFrameRate {
  if (env.sourceRate === null) return 60;
  const limit = env.sourceRate * Math.max(1, speed) * 1.05;
  return EXPORT_FRAME_RATES.findLast((rate) => rate <= limit) ?? 10;
}

export function frameRateAllowed(rate: ExportFrameRate, env: ExportEnvironment, speed: number) {
  return rate <= maxFrameRate(env, speed);
}

export function presetOptions(
  preset: ExportPreset,
  env: ExportEnvironment,
  speed: number,
): ExportOptions {
  const cap = maxFrameRate(env, speed);
  const clean = { format: "mp4", dot: "off", captions: false } as const;
  if (preset === "quality")
    return {
      ...clean,
      size:
        (env.source ? (["source", "1080p", "720p"] as const) : (["1080p", "720p"] as const)).find(
          (size) => encodes(env, "mp4", size, "off"),
        ) ?? "480p",
      fps: cap,
      quality: "high",
    };
  if (preset === "showcase")
    return {
      ...clean,
      size:
        (["1080p", "720p"] as const).find((size) => encodes(env, "mp4", size, "under")) ?? "480p",
      fps: cap >= 60 ? 60 : cap >= 30 ? 30 : cap,
      quality: "high",
      dot: "under",
    };
  const small = env.source !== null && env.source.w < FIXED_SIZES["720p"].w;
  return {
    ...clean,
    size: small ? "source" : encodes(env, "mp4", "720p", "off") ? "720p" : "480p",
    fps: Math.min(15, cap) as ExportFrameRate,
    quality: "low",
  };
}

// Choosing a preset; Showcase also plays the recording at its own pace with the waits left out.
export function choosePreset(choices: ExportChoices, preset: PresetChoice): ExportChoices {
  return preset === "showcase"
    ? { ...choices, preset, speed: 1, skipIdle: true }
    : { ...choices, preset };
}

const same = (a: ExportOptions, b: ExportOptions) =>
  a.size === b.size &&
  a.fps === b.fps &&
  a.quality === b.quality &&
  a.format === b.format &&
  a.dot === b.dot &&
  a.captions === b.captions;

// Custom values this recording and browser cannot make become the nearest they can.
export function fitOptions(
  options: ExportOptions,
  env: ExportEnvironment,
  speed: number,
): ExportOptions {
  const { dot } = options;
  const format = encodes(env, options.format, options.size, dot) ? options.format : "mp4";
  const size = encodes(env, format, options.size, dot)
    ? options.size
    : ([...SIZE_CHOICES].reverse().find((choice) => encodes(env, format, choice, dot)) ?? "480p");
  const cap = maxFrameRate(env, speed);
  return { ...options, size, format, fps: Math.min(options.fps, cap) as ExportFrameRate };
}

export function optionsFor(choices: ExportChoices, env: ExportEnvironment): ExportOptions {
  return choices.preset === "custom"
    ? fitOptions(choices.custom, env, choices.speed)
    : presetOptions(choices.preset, env, choices.speed);
}

// A changed value keeps a preset's name while the values are still that preset's.
export function withOption(
  choices: ExportChoices,
  env: ExportEnvironment,
  patch: Partial<ExportOptions>,
): ExportChoices {
  const next = fitOptions({ ...optionsFor(choices, env), ...patch }, env, choices.speed);
  const preset =
    PRESETS.find((name) => same(next, presetOptions(name, env, choices.speed))) ?? "custom";
  return { ...choices, preset, custom: preset === "custom" ? next : choices.custom };
}

export function exportRequest(
  sessionId: string,
  range: { fromMs: number; toMs: number },
  choices: ExportChoices,
  env: ExportEnvironment,
): ExportRequest {
  const options = optionsFor(choices, env);
  return {
    sessionId,
    fromMs: range.fromMs,
    toMs: range.toMs,
    speed: choices.speed,
    skipIdle: choices.skipIdle,
    captions: options.captions,
    overlays: choices.overlays,
    ...(options.dot !== "off" && { dot: options.dot }),
    size: sizeOf(options.size, env, options.dot),
    fps: options.fps,
    quality: options.quality,
    format: options.format,
  };
}

// The speeds − and + step through.
export const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16];

export function stepSpeed(speed: number, direction: 1 | -1): number {
  const next =
    direction > 0
      ? SPEED_STEPS.find((step) => step > speed + 1e-9)
      : SPEED_STEPS.findLast((step) => step < speed - 1e-9);
  return next ?? speed;
}

// What a typed speed means: "2.5", "2.5x" or "2.5×", kept within what an export can play. Null when
// it is not a number.
export function parseSpeed(text: string): number | null {
  const match = /^\s*(\d+(?:[.,]\d*)?|[.,]\d+)\s*[x×]?\s*$/i.exec(text);
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(SPEED_LIMITS.max, Math.max(SPEED_LIMITS.min, Math.round(value * 100) / 100));
}

export const CHOICES_KEY = "localdot.export.v2";

const oneOf = <T extends string | number>(list: readonly T[], value: unknown, fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback;
const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

export function parseChoices(text: string | null): ExportChoices {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = text === null ? null : JSON.parse(text);
    if (parsed && typeof parsed === "object") value = parsed as Record<string, unknown>;
  } catch {}
  const custom = (value.custom && typeof value.custom === "object" ? value.custom : {}) as Record<
    string,
    unknown
  >;
  const fallback = DEFAULT_CHOICES;
  const speed = typeof value.speed === "number" && validSpeed(value.speed) ? value.speed : 1;
  return {
    preset: oneOf([...PRESETS, "custom"] as const, value.preset, fallback.preset),
    custom: {
      size: oneOf(SIZE_CHOICES, custom.size, fallback.custom.size),
      fps: oneOf(EXPORT_FRAME_RATES, custom.fps, fallback.custom.fps),
      quality: oneOf(EXPORT_QUALITIES, custom.quality, fallback.custom.quality),
      format: oneOf(EXPORT_FORMATS, custom.format, fallback.custom.format),
      dot: oneOf(["off", ...DOT_PLACEMENTS] as const, custom.dot, fallback.custom.dot),
      // Before presets set it, the step caption was kept apart from them.
      captions: flag(custom.captions, flag(value.captions, fallback.custom.captions)),
    },
    place: oneOf(DOT_PLACEMENTS, value.place, fallback.place),
    speed,
    skipIdle: flag(value.skipIdle, fallback.skipIdle),
    overlays: flag(value.overlays, fallback.overlays),
    snap: flag(value.snap, fallback.snap),
  };
}

export function storedChoices(): ExportChoices {
  try {
    return parseChoices(localStorage.getItem(CHOICES_KEY));
  } catch {
    return DEFAULT_CHOICES;
  }
}

export function keepChoices(choices: ExportChoices): void {
  try {
    localStorage.setItem(CHOICES_KEY, JSON.stringify(choices));
  } catch {}
}
