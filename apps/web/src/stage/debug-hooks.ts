import type { ReplaySpeed } from "@localdot/stage";
import type { ExportProbe } from "../export/export-probe.ts";
import type { Flip, ProbeRect } from "./probe.ts";
import type { ReplayProbeRequest, ReplayStatus } from "./worker-protocol.ts";

export interface ProbeApi {
  start(rect: ProbeRect, threshold?: number): void;
  stop(): void;
  flips(): Flip[];
  clear(): void;
}

export interface ReplayDebugHook {
  status(): ReplayStatus["state"];
  seek(tMs: number, mode: "exact" | "preview"): Promise<void>;
  transport(patch: { playing?: boolean; speed?: ReplaySpeed; skipIdle?: boolean }): void;
  probe(command: ReplayProbeRequest): Promise<unknown>;
}

declare global {
  interface Window {
    __localdot?: {
      probe?: ProbeApi;
      oracle?: unknown;
      replay?: ReplayDebugHook;
      exportProbe?: ExportProbe;
    };
  }
}
