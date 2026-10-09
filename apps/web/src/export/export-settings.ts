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
  validSpeed,
} from "./export-plan.ts";

export const SIZE_CHOICES = ["480p", "720p", "1080p", "source"] as const;
export type SizeChoice = (typeof SIZE_CHOICES)[number];
const FIXED_SIZES: Record<Exclude<SizeChoice, "source">, ExportSize> = {
  "480p": { w: 768, h: 480 },
  "720p": { w: 1280, h: 800 },
  "1080p": { w: 1920, h: 1200 },
};

export type ExportPreset = "quality" | "fast";
export type PresetChoice = ExportPreset | "custom";

// What the presets set; the rest of the choices are kept across them.
export interface ExportOptions {
  size: SizeChoice;
  fps: ExportFrameRate;
  quality: ExportQuality;
  format: ExportFormat;
}

export interface ExportChoices {
  preset: PresetChoice;
  // The viewer's own values, used while the preset is custom.
  custom: ExportOptions;
  speed: number;
  captions: boolean;
  skipIdle: boolean;
  overlays: boolean;
}

// What this recording and this browser allow. Unknown (null) allows, so nothing is held back while
// the checks run.
export interface ExportEnvironment {
  // The recording's own picture size.
  source: ExportSize | null;
  // Frames per second the recording was made at, while things moved on the screen.
  sourceRate: number | null;
  encodable: Record<ExportFormat, Partial<Record<SizeChoice, boolean>>>;
}

export const UNKNOWN_ENVIRONMENT: ExportEnvironment = {
  source: null,
  sourceRate: null,
  encodable: { mp4: {}, webm: {} },
};

export const DEFAULT_CHOICES: ExportChoices = {
  preset: "quality",
  custom: { size: "1080p", fps: 30, quality: "medium", format: "mp4" },
  speed: 1,
  captions: false,
  skipIdle: true,
  overlays: true,
};

const even = (value: number) => Math.max(16, 2 * Math.round(value / 2));

// The recording's own size, made smaller to fit the largest export when it is bigger.
export function sourceSize(source: ExportSize): ExportSize {
  const scale = Math.min(1, MAX_EXPORT_SIZE.w / source.w, MAX_EXPORT_SIZE.h / source.h);
  return { w: even(source.w * scale), h: even(source.h * scale) };
}

export function sizeOf(choice: SizeChoice, env: ExportEnvironment): ExportSize {
  if (choice !== "source") return FIXED_SIZES[choice];
  return env.source ? sourceSize(env.source) : FIXED_SIZES["1080p"];
}

export function sizeLabel(choice: SizeChoice): string {
  return choice === "source" ? "Original" : choice;
}

const encodes = (env: ExportEnvironment, format: ExportFormat, size: SizeChoice) =>
  env.encodable[format][size] !== false;

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
  if (preset === "quality")
    return {
      size:
        (env.source ? (["source", "1080p", "720p"] as const) : (["1080p", "720p"] as const)).find(
          (size) => encodes(env, "mp4", size),
        ) ?? "480p",
      fps: cap,
      quality: "high",
      format: "mp4",
    };
  const small = env.source !== null && env.source.w < FIXED_SIZES["720p"].w;
  return {
    size: small ? "source" : encodes(env, "mp4", "720p") ? "720p" : "480p",
    fps: Math.min(15, cap) as ExportFrameRate,
    quality: "low",
    format: "mp4",
  };
}

const same = (a: ExportOptions, b: ExportOptions) =>
  a.size === b.size && a.fps === b.fps && a.quality === b.quality && a.format === b.format;

// Custom values this recording and browser cannot make become the nearest they can.
export function fitOptions(
  options: ExportOptions,
  env: ExportEnvironment,
  speed: number,
): ExportOptions {
  const format = encodes(env, options.format, options.size) ? options.format : "mp4";
  const size = encodes(env, format, options.size)
    ? options.size
    : ([...SIZE_CHOICES].reverse().find((choice) => encodes(env, format, choice)) ?? "480p");
  const cap = maxFrameRate(env, speed);
  return {
    size,
    format,
    quality: options.quality,
    fps: Math.min(options.fps, cap) as ExportFrameRate,
  };
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
    (["quality", "fast"] as const).find((name) =>
      same(next, presetOptions(name, env, choices.speed)),
    ) ?? "custom";
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
    captions: choices.captions,
    overlays: choices.overlays,
    size: sizeOf(options.size, env),
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
    preset: oneOf(["quality", "fast", "custom"] as const, value.preset, fallback.preset),
    custom: {
      size: oneOf(SIZE_CHOICES, custom.size, fallback.custom.size),
      fps: oneOf(EXPORT_FRAME_RATES, custom.fps, fallback.custom.fps),
      quality: oneOf(EXPORT_QUALITIES, custom.quality, fallback.custom.quality),
      format: oneOf(EXPORT_FORMATS, custom.format, fallback.custom.format),
    },
    speed,
    captions: flag(value.captions, fallback.captions),
    skipIdle: flag(value.skipIdle, fallback.skipIdle),
    overlays: flag(value.overlays, fallback.overlays),
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
