import type {
  LocalDotEvent,
  Point,
  RecordingGap,
  Rect,
  ScreenName,
  ScreenSelectionSnapshot,
} from "@localdot/protocol";
import type { PlaybackMap, ReplaySpeed } from "@localdot/stage";
import type { Flip, ProbeRect } from "./probe.ts";
import type { PumpStats } from "./pump.ts";
import type { StageTheme } from "./theme.ts";

export interface StageClock {
  offsetMicros: number;
  originMicros: number;
}

export interface StageViewPatch {
  selection?: ScreenSelectionSnapshot | null;
  zoom?: number;
  freeze?: boolean;
  reducedMotion?: boolean;
  // A decision is open over the picture.
  dim?: boolean;
  // The fields dot will type the user's answers into while it waits on them.
  fields?: readonly FieldMark[];
  // The stream's frame rate, which caps how often the stage looks; and whether it is out of sight.
  fps?: number;
  hidden?: boolean;
}

// A field on one of the screens, in that screen's pixels.
export interface FieldMark {
  screen: ScreenName;
  point: Point;
  bbox?: Rect;
}

export interface ReplaySource {
  screen?: ScreenName;
  geometry?: { w: number; h: number; scale: number };
  owner?: number;
  sessionId: string;
  origin: string;
  authorization: string;
  video: { upto: number | null } | null;
  gaps: RecordingGap[];
}

export interface ReplayTransport {
  playing: boolean;
  speed: ReplaySpeed;
  map: PlaybackMap;
  atPlayMs: number;
}

export type ReplayStatus =
  | { state: "loading" }
  | { state: "ready"; firstMs: number | null; lastMs: number | null }
  | { state: "no-video" }
  | { state: "error"; message: string };

export type ReplayProbeCommand =
  | { id: number; op: "enable" }
  | { id: number; op: "mb-luma"; widthMbs: number; heightMbs: number }
  | { id: number; op: "thumb"; w: number; h: number }
  | { id: number; op: "overlay-hash"; tMs: number }
  | { id: number; op: "stats" };

export type ReplayProbeRequest = ReplayProbeCommand extends infer Command
  ? Command extends unknown
    ? Omit<Command, "id">
    : never
  : never;

export type WorkerIn =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      dpr: number;
      theme: StageTheme;
      reducedMotion: boolean;
    }
  | { type: "resize"; width: number; height: number }
  // S8's seed travels with the readable (Part 2's Task 14): the <video>'s frame at tap time.
  | {
      type: "frames";
      sourceId?: number;
      readable?: ReadableStream<VideoFrame>;
      // Safari: a clone of the client's track, which the worker reads.
      track?: MediaStreamTrack;
      // The frames follow as "frame" messages for this source.
      pushed?: boolean;
      first?: VideoFrame;
    }
  | { type: "frame"; sourceId?: number; frame: VideoFrame }
  | { type: "stop" }
  | { type: "probe"; rect: ProbeRect | null; threshold: number }
  | { type: "events"; events: LocalDotEvent[] }
  | { type: "session-reset" }
  | { type: "clock"; clock: StageClock }
  | { type: "view"; view: StageViewPatch }
  | { type: "theme"; theme: StageTheme }
  | { type: "replay-open"; source: ReplaySource }
  | { type: "replay-transport"; transport: ReplayTransport }
  | { type: "replay-seek"; tMs: number; mode: "exact" | "preview" }
  | { type: "replay-close" }
  | { type: "replay-probe"; command: ReplayProbeCommand }
  | { type: "oracle"; command: OracleCommand };

export type WorkerOut =
  // Sent once as the worker starts: whether it can read a track handed to it.
  | { type: "caps"; tracks: boolean }
  | { type: "stats"; sourceId?: number; stats: PumpStats }
  | { type: "error"; message: string }
  | { type: "warn"; message: string }
  | { type: "flip"; flip: Flip }
  | { type: "replay-time"; tMs: number; playing: boolean; idle: boolean; owner?: number }
  | { type: "replay-status"; status: ReplayStatus; owner?: number }
  | { type: "replay-ended"; owner?: number }
  | { type: "replay-probe-reply"; id: number; reply: unknown }
  | { type: "oracle-reply"; id: number; reply: unknown };

// Task 16 fills these in; declared here so the protocol has one home.
export type OracleCommand =
  | { id: number; op: "enable"; zooms: number[] }
  | { id: number; op: "dump" }
  | { id: number; op: "template" }
  | { id: number; op: "render-twice"; tMs: number };

// A command as the page writes it, before the canvas numbers it: still a union (a plain Omit of the
// union would keep only the keys every member shares, `op`).
export type OracleRequest = OracleCommand extends infer C
  ? C extends unknown
    ? Omit<C, "id">
    : never
  : never;
