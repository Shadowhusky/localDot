import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";
import { ScreenName } from "./screens.ts";

export const EXPORT_FRAME_RATES = [10, 15, 24, 30, 50, 60] as const;
export type ExportFrameRate = (typeof EXPORT_FRAME_RATES)[number];
export const EXPORT_QUALITIES = ["low", "medium", "high"] as const;
export type ExportQuality = (typeof EXPORT_QUALITIES)[number];
export const EXPORT_FORMATS = ["mp4", "webm"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const SPEED_LIMITS = { min: 0.25, max: 16 } as const;
// The largest picture an export makes: the computer's own screen.
export const MAX_EXPORT_SIZE = { w: 2560, h: 1600 } as const;

export interface ExportSize {
  w: number;
  h: number;
}

export function validSpeed(speed: number): boolean {
  return Number.isFinite(speed) && speed >= SPEED_LIMITS.min && speed <= SPEED_LIMITS.max;
}

export function validSize(size: ExportSize): boolean {
  return (
    Number.isSafeInteger(size.w) &&
    Number.isSafeInteger(size.h) &&
    size.w % 2 === 0 &&
    size.h % 2 === 0 &&
    size.w >= 16 &&
    size.h >= 16 &&
    Math.max(size.w, size.h) <= MAX_EXPORT_SIZE.w &&
    size.w * size.h <= MAX_EXPORT_SIZE.w * MAX_EXPORT_SIZE.h
  );
}

const Ulid = z.string().regex(ULID_PATTERN);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SessionMs = z.number().finite().min(0).max(1e12);

export const ExportRequest = z
  .strictObject({
    sessionId: Ulid,
    fromMs: SessionMs,
    toMs: SessionMs,
    // Session time per second of video: 2 plays twice as fast, 0.5 at half speed.
    speed: z.number().refine(validSpeed),
    skipIdle: z.boolean(),
    captions: z.boolean(),
    // dot's pointer, clicks and typing drawn over the picture.
    overlays: z.boolean(),
    size: z.strictObject({ w: z.number(), h: z.number() }).refine(validSize),
    fps: z.union(EXPORT_FRAME_RATES.map((rate) => z.literal(rate))),
    quality: z.enum(EXPORT_QUALITIES),
    format: z.enum(EXPORT_FORMATS),
  })
  .refine((request) => request.toMs > request.fromMs);
export type ExportRequest = z.infer<typeof ExportRequest>;

export const ExportStart = z.strictObject({ request: ExportRequest, screen: ScreenName });
export type ExportStart = z.infer<typeof ExportStart>;

// queued → making → done; or failed (with a retry), or cancelled, which leaves nothing behind.
export const ExportPhase = z.enum(["queued", "making", "done", "failed"]);
export type ExportPhase = z.infer<typeof ExportPhase>;

// A video the host makes, or made, for anyone signed in to see and save.
export const HostExport = z.strictObject({
  id: Ulid,
  sessionId: Ulid,
  screen: ScreenName,
  // The file's name when saved.
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
  phase: ExportPhase,
  createdAt: Count,
  // Frames of the video made so far, of all it will have; 0 of 0 until the plan is known.
  done: Count,
  total: Count,
  // Time spent making it, and the time it is expected to take still.
  elapsedMs: Count,
  leftMs: Count.nullable(),
  bytes: Count,
  durationS: z.number().finite().nonnegative().nullable(),
  // Why it failed, in plain words.
  error: z.string().max(300).nullable(),
  request: ExportRequest,
});
export type HostExport = z.infer<typeof HostExport>;

// Whether the host can make videos, and the largest picture (width × height) it can encode in
// each format; checking until it has tried its browser once.
export const ExportHost = z.strictObject({
  state: z.enum(["checking", "ready", "unavailable"]),
  maxPixels: z.strictObject({ mp4: Count, webm: Count }),
});
export type ExportHost = z.infer<typeof ExportHost>;

export const ExportsState = z.strictObject({
  host: ExportHost,
  exports: z.array(HostExport).max(64),
});
export type ExportsState = z.infer<typeof ExportsState>;

export const ExportLink = z.strictObject({
  href: z.string().regex(/^\/export-files\/[A-Za-z0-9_-]{43}$/),
});
export type ExportLink = z.infer<typeof ExportLink>;

// Between the daemon and its private export page, over the browser's debugging pipe.
export const EXPORT_CHUNK_BYTES = 4 * 1024 * 1024;

export const ExportHostCheck = z.strictObject({
  maxPixels: z.strictObject({ mp4: Count, webm: Count }),
  // The recordings are H.264.
  decodes: z.boolean(),
  // The graphics the page draws with, as the browser names them; null without WebGL.
  graphics: z.string().max(300).nullable(),
});
export type ExportHostCheck = z.infer<typeof ExportHostCheck>;

export const ExportPageMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("progress"), done: Count, total: Count }),
  z.strictObject({
    type: z.literal("chunk"),
    seq: Count,
    position: Count,
    data: z.string().max(Math.ceil(EXPORT_CHUNK_BYTES / 3) * 4),
  }),
  z.strictObject({ type: z.literal("done"), frames: Count, bytes: Count }),
  z.strictObject({ type: z.literal("error"), message: z.string().max(300) }),
]);
export type ExportPageMessage = z.infer<typeof ExportPageMessage>;
