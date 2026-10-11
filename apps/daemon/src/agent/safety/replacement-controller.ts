import { setTimeout as sleep } from "node:timers/promises";
import { ulid } from "@localdot/protocol";
import type { CellOrchestrator } from "../../cells/orchestrator.ts";
import type { TicketRegistry } from "../../cells/secrets.ts";
import type { AgentRunner } from "../runner.ts";
import type { ComputerFences } from "./fences.ts";
import { ReplacementOwner } from "./replacement.ts";
import { ReplacementStore } from "./replacement-store.ts";
export interface ReplacementControllerDeps {
  home: string;
  fences: ComputerFences;
  runner: Pick<AgentRunner, "replacementOwner" | "retireForReplacement">;
  cells: Pick<
    CellOrchestrator,
    | "record"
    | "get"
    | "endpoints"
    | "create"
    | "holdReplacement"
    | "publishReplacement"
    | "inspectReplacement"
    | "retireReplacement"
    | "updateStream"
  >;
  tickets: TicketRegistry;
  readyTimeoutMs?: number;
}
export function createReplacementController(d: ReplacementControllerDeps) {
  let store: ReplacementStore | undefined;
  try {
    store = new ReplacementStore(d.home);
    for (const record of store.list())
      if (record.newCellId && !(record.phase === "ready" && d.fences.record(record.newCellId)))
        d.cells.holdReplacement(record.newCellId);
  } catch {
    d.fences.closeAdmission();
  }
  const records = () => {
    if (!store) throw new Error("replacement records unavailable");
    return store;
  };
  d.fences.subscribe((id) => {
    d.tickets.revoke(id);
    d.cells.updateStream(id, { connection: "none", viewers: 0, lastUpstreamAt: null });
  });
  const owner = new ReplacementOwner({
    onReady: (record) => {
      if (record.newCellId) d.cells.publishReplacement(record.newCellId);
    },
    expectedRequests: () =>
      d.fences
        .records()
        .flatMap((record) =>
          record.replacementRequest
            ? [{ oldCellId: record.cellId, requestId: record.replacementRequest }]
            : [],
        ),
    store: {
      read: (id) => records().read(id),
      list: () => records().list(),
      write: (record) => {
        records().write(record);
        if (record.phase === "retiring")
          d.fences.claimReplacement(record.oldCellId, record.requestId);
        if (record.newCellId) {
          if (record.phase === "allocating") d.cells.holdReplacement(record.newCellId);
          else if (record.phase === "blocked") d.cells.publishReplacement(record.newCellId);
        }
      },
    },
    forCell: (oldCellId) => ({
      current: () => d.runner.replacementOwner(oldCellId),
      save: async () => {},
      allocateId: ulid,
      retireOld: async (id) => {
        d.tickets.revoke(id);
        if (!(await d.runner.retireForReplacement(id)))
          return { absent: false, revoked: false, streamClosed: false };
        const result = await d.cells.retireReplacement(id);
        return {
          ...result,
          streamClosed:
            !d.tickets.hasLiveTicket(id) &&
            !d.cells.endpoints(id) &&
            d.cells.get(id)?.stream.viewers === 0,
        };
      },
      createFresh: async (id) => {
        const record = d.cells.record(oldCellId);
        if (!record) throw new Error("old computer record unavailable");
        await d.cells.create({ id, scale: record.scale, restoreFrom: oldCellId });
        const deadline = Date.now() + (d.readyTimeoutMs ?? 180000);
        for (;;) {
          const cell = d.cells.get(id);
          if (cell?.state === "ready" && !cell.paused) {
            if ((await d.cells.inspectReplacement(id)) !== "ready")
              throw new Error("candidate ownership unavailable");
            return;
          }
          if (
            !cell ||
            cell.state === "failed" ||
            cell.state === "removed" ||
            Date.now() >= deadline
          )
            throw new Error("fresh computer readiness unconfirmed");
          await sleep(20);
        }
      },
      retireFresh: async (id) => {
        const result = await d.cells.retireReplacement(id, true);
        if (!result.absent || !result.revoked) throw new Error("candidate cleanup unconfirmed");
      },
      inspectFresh: (id) => d.cells.inspectReplacement(id),
    }),
  });
  return {
    owner,
    fence: (id: string) => {
      const record = d.fences.record(id);
      return record
        ? {
            revision: record.revision,
            ...(record.replacementRequest ? { replacementRequest: record.replacementRequest } : {}),
          }
        : undefined;
    },
  };
}
