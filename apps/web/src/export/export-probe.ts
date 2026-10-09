import type { ExportRequest } from "./export-plan.ts";

export type ExportProbeOptions = Partial<Omit<ExportRequest, "sessionId">> & { hashes?: boolean };
export interface ExportProbeResult {
  frames: number;
  bytes: number;
  hashes: string[] | null;
  peakOpenFrames: number;
  peakEncodeQueue: number;
  ms: number;
}
export interface ExportProbe {
  run(options: ExportProbeOptions): Promise<ExportProbeResult>;
  cancel(): void;
  sourcesBetween(fromMs: number, toMs: number): string[];
}
