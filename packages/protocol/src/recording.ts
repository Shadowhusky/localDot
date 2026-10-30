import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";
import { SessionOrigin } from "./routines.ts";
import type { ScreenName } from "./screens.ts";

// One recording lives beneath <home>/sessions/<id>/recording/. Fragment bytes
// commit before their JSONL entry; manifest.json is replaced atomically.
export const RECORDING_DIR = "recording";
export const BROWSER_RECORDING_DIR = "recording-browser";
export function recordingDirectory(screen: ScreenName): string {
  if (screen === "desktop") return RECORDING_DIR;
  if (screen === "browser") return BROWSER_RECORDING_DIR;
  throw new RangeError("Invalid recording screen.");
}
export const RECORDING_VIDEO = "video.mp4";
export const RECORDING_FRAGMENTS = "fragments.jsonl";
export const RECORDING_MANIFEST = "manifest.json";
export const RECORDING_JOURNAL = "journal";
export const SESSION_SUMMARY = "summary.json";
export const SESSION_THUMBS = "thumbs";

// Media timestamps share the event envelope's session microsecond clock.
export const MEDIA_TIMESCALE = 1_000_000;
export const ACTIVITY_JOIN_MICROS = 500_000;

const Micros = z.number().int().nonnegative();
const Ulid = z.string().regex(ULID_PATTERN);

export const RecordingState = z.enum([
  "recording",
  "complete",
  "recovered",
  "failed",
  "expired",
  "none",
]);
export type RecordingState = z.infer<typeof RecordingState>;

export const RecordingGapReason = z.enum([
  "user-control",
  "stream-lost",
  "disk-full",
  "size-cap",
  "recorder-error",
]);
export type RecordingGapReason = z.infer<typeof RecordingGapReason>;

// A null end is an ongoing gap or a recording that ended inside that gap.
export const RecordingGap = z
  .object({ from: Micros, to: Micros.nullable(), reason: RecordingGapReason })
  .refine((gap) => gap.to === null || gap.to >= gap.from, {
    message: "a recording gap cannot end before it starts",
  });
export type RecordingGap = z.infer<typeof RecordingGap>;

export const ActivitySpan = z
  .object({ from: Micros, to: Micros })
  .refine((span) => span.to >= span.from, {
    message: "an activity span cannot end before it starts",
  });
export type ActivitySpan = z.infer<typeof ActivitySpan>;

export const RecordingManifest = z
  .object({
    v: z.literal(1),
    state: RecordingState,
    codec: z
      .string()
      .regex(/^avc1\.[0-9a-f]{6}$/)
      .nullable(),
    width: z.number().int().positive().max(16_384).nullable(),
    height: z.number().int().positive().max(16_384).nullable(),
    firstMicros: Micros.nullable(),
    lastMicros: Micros.nullable(),
    bytes: z.number().int().nonnegative(),
    fragments: z.number().int().nonnegative(),
    activity: z.array(ActivitySpan).max(200_000),
    gaps: z.array(RecordingGap).max(10_000),
    // True only when video.mp4 has a complete mfra tail. Otherwise the indexed
    // fragments are served with a freshly synthesized tail, never as a raw file.
    finalized: z.boolean(),
    note: z.string().max(200).optional(),
    // Set once the finished video was re-encoded to save space, or kept because that saved too
    // little: the bytes it took before. `bytes` is what it takes now.
    compacted: z.object({ sourceBytes: z.number().int().positive() }).optional(),
  })
  .refine(
    (manifest) =>
      manifest.firstMicros === null ||
      manifest.lastMicros === null ||
      manifest.lastMicros >= manifest.firstMicros,
    { message: "a recording cannot end before its first frame" },
  );
export type RecordingManifest = z.infer<typeof RecordingManifest>;

export const FragmentEntry = z
  .object({
    seq: z.number().int().positive(),
    moofOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    startMicros: Micros,
    endMicros: Micros,
  })
  .refine((entry) => entry.endOffset > entry.moofOffset, {
    message: "a fragment must end after its moof offset",
  })
  .refine((entry) => entry.endMicros >= entry.startMicros, {
    message: "a fragment cannot end before it starts",
  });
export type FragmentEntry = z.infer<typeof FragmentEntry>;

export function emptyManifest(state: RecordingState, note?: string): RecordingManifest {
  return {
    v: 1,
    state,
    codec: null,
    width: null,
    height: null,
    firstMicros: null,
    lastMicros: null,
    bytes: 0,
    fragments: 0,
    activity: [],
    gaps: [],
    finalized: false,
    ...(note !== undefined ? { note } : {}),
  };
}

export const SessionVerdict = z.enum(["live", "done", "stopped", "error", "interrupted"]);
export type SessionVerdict = z.infer<typeof SessionVerdict>;

const RecordingSummary = z.object({ state: RecordingState, bytes: z.number().int().nonnegative() });

export const SessionCard = z.object({
  id: Ulid,
  title: z.string().max(200).nullable(),
  startedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative().nullable(),
  verdict: SessionVerdict,
  steps: z.number().int().nonnegative(),
  failedSteps: z.number().int().nonnegative(),
  coverFrameId: Ulid.nullable(),
  screen: z
    .object({
      w: z.number().int().positive(),
      h: z.number().int().positive(),
      scale: z.number().positive(),
    })
    .nullable(),
  recording: RecordingSummary,
  // Older sessions and clients expose the desktop-only `recording` field.
  recordings: z.object({ desktop: RecordingSummary, browser: RecordingSummary }).optional(),
  origin: SessionOrigin.optional(),
  // Everything the task keeps on this computer (videos, screenshots, history, saved files): what
  // deleting it frees. Older daemons leave it out.
  diskBytes: z.number().int().nonnegative().optional(),
});
export type SessionCard = z.infer<typeof SessionCard>;

export const SessionIndexPage = z.object({
  sessions: z.array(SessionCard),
  next: z.string().nullable(),
});
export type SessionIndexPage = z.infer<typeof SessionIndexPage>;

export const DELETE_SESSIONS_MAX = 100;
export const DeleteSessionsRequest = z.strictObject({
  ids: z.array(Ulid).min(1).max(DELETE_SESSIONS_MAX),
});
export type DeleteSessionsRequest = z.infer<typeof DeleteSessionsRequest>;

// Each id lands in one list. A task already gone counts as deleted, so a retry is harmless; a
// running task is never deleted.
export const DeleteSessionsResult = z.object({
  deleted: z.array(Ulid),
  live: z.array(Ulid),
  failed: z.array(Ulid),
});
export type DeleteSessionsResult = z.infer<typeof DeleteSessionsResult>;

// What the finished task videos on this computer take, what re-encoding them saved, and the rule
// that removes the oldest.
export const RecordingStorage = z.object({
  videos: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  savedBytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive(),
  maxAgeDays: z.number().positive(),
  framesBytes: z.number().int().nonnegative(),
  framesMaxAgeDays: z.number().positive(),
});
export type RecordingStorage = z.infer<typeof RecordingStorage>;

export const RecordingInfo = z.object({
  manifest: RecordingManifest,
  live: z.boolean(),
  // A video.mp4?upto=<fragments> snapshot includes only committed fragments.
  upto: z.number().int().nonnegative(),
  servedBytes: z.number().int().nonnegative(),
});
export type RecordingInfo = z.infer<typeof RecordingInfo>;
