import type { LocalDotEvent } from "@localdot/protocol";
import type { Flip, ProbeRect } from "./probe.ts";
import type { PumpStats } from "./pump.ts";
import type { StageTheme } from "./theme.ts";

export interface StageClock {
  offsetMicros: number;
  originMicros: number;
}

export interface StageViewPatch {
  zoom?: number;
  freeze?: boolean;
  reducedMotion?: boolean;
}

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
  | { type: "frames"; readable: ReadableStream<VideoFrame>; first?: VideoFrame }
  | { type: "stop" }
  | { type: "probe"; rect: ProbeRect | null; threshold: number }
  | { type: "events"; events: LocalDotEvent[] }
  | { type: "session-reset" }
  | { type: "clock"; clock: StageClock }
  | { type: "view"; view: StageViewPatch }
  | { type: "theme"; theme: StageTheme }
  | { type: "oracle"; command: OracleCommand };

export type WorkerOut =
  | { type: "stats"; stats: PumpStats }
  | { type: "error"; message: string }
  | { type: "warn"; message: string }
  | { type: "flip"; flip: Flip }
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
