import type { StageTheme } from "../stage/theme.ts";
import type { ExportContext } from "./export-context.ts";
import type { ExportRequest } from "./export-plan.ts";

export type PreviewIn =
  | {
      type: "start";
      canvas: OffscreenCanvas;
      context: ExportContext;
      request: ExportRequest;
      theme: StageTheme;
    }
  | { type: "frame"; index: number };
export type PreviewOut =
  | { type: "ready" }
  | { type: "frame"; index: number; sessionMs: number }
  | { type: "error" };
