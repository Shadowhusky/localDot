import type { SettleRequest, SettleResult } from "@localdot/protocol";
import type { XHelper } from "./x/helper.ts";

interface HelperSettle {
  changed: [number, number, number, number][];
  lastChange: number | null;
  quiet: boolean;
  noVisibleChange: boolean;
}

export async function settle(x: XHelper, req: SettleRequest): Promise<SettleResult> {
  const r = await x.call<HelperSettle>("settle", req, req.timeoutMs + 1000);
  return {
    changed: r.changed.map(([x0, y0, w, h]) => ({ x: x0, y: y0, w, h })),
    lastChangeMono: r.lastChange,
    quiet: r.quiet,
    noVisibleChange: r.noVisibleChange,
  };
}
