import type { ActivitySpan, RecordingGap } from "@localdot/protocol";
import type { SessionModel } from "@localdot/stage";
import type { StageTheme } from "../stage/theme.ts";
import type { ReplaySource } from "../stage/worker-protocol.ts";
import type { ExportRequest } from "./export-plan.ts";

export interface ExportSourceSample {
  tMs: number;
  source: "video" | "backdrop" | "hold";
}

export type ExportIn =
  | {
      type: "start";
      request: ExportRequest;
      source: ReplaySource;
      model: SessionModel;
      activity: ActivitySpan[];
      gaps: RecordingGap[];
      theme: StageTheme;
      hashes: boolean;
      probe?: boolean;
    }
  | { type: "ack"; chunk: number }
  | { type: "cancel" };
export type ExportOut =
  | { type: "sources"; entries: ExportSourceSample[] }
  | { type: "chunk"; chunk: number; position: number; data: ArrayBuffer }
  | { type: "progress"; done: number; total: number; openFrames: number; encodeQueue: number }
  | { type: "done"; frames: number; bytes: number; hashes: string[] | null }
  | { type: "error"; message: string }
  | { type: "cancelled" };
export const EXPORT_MAX_INFLIGHT_CHUNKS = 4;
