import { setTimeout as sleep } from "node:timers/promises";
import { ulid } from "@localdot/protocol";
import {
  type ComputerResetRecord,
  ComputerResetRequest,
  ComputerResetSource,
} from "../../../../packages/protocol/src/computer-reset.ts";
import type { AgentRunner } from "../agent/runner.ts";
import type { ComputerFences } from "../agent/safety/fences.ts";
import type { KeydClient } from "../keyd/client.ts";
import type { BrowserOrchestrator } from "./browser-orchestrator.ts";
import type { DockerClient } from "./docker.ts";
import type { CellOrchestrator } from "./orchestrator.ts";
import type { ComputerResetHolds } from "./reset-holds.ts";
import { ComputerResetOwner } from "./reset-owner.ts";
import {
  computerResetResourcesAbsent,
  retireComputerResetResources,
  verifyComputerResetResources,
} from "./reset-resources.ts";
import { captureComputerResetSource } from "./reset-source.ts";
import { ComputerResetStore } from "./reset-store.ts";

export interface ComputerResetControllerDeps {
  home: string;
  holds: ComputerResetHolds;
  fences: ComputerFences;
  docker: Pick<DockerClient, "request">;
  keyd: Pick<KeydClient, "cell">;
  runner: Pick<AgentRunner, "retireForReset" | "resetTaskDrained">;
  cells: Pick<
    CellOrchestrator,
    | "record"
    | "hasStoredIdentity"
    | "get"
    | "create"
    | "retireReset"
    | "inspectReplacement"
    | "retireReplacement"
    | "holdReplacement"
    | "publishReplacement"
  >;
  browser: Pick<BrowserOrchestrator, "resetSource" | "resetRetired" | "retireReset">;
  available(): boolean;
  stopping?(): boolean;
  allocateId?(): string;
  readyTimeoutMs?: number;
}
const failure = () =>
  new Error("Computer reset is unconfirmed. Retry the same request explicitly.");

export function createComputerResetController(d: ComputerResetControllerDeps) {
  let store: ComputerResetStore | undefined;
  try {
    store = new ComputerResetStore(d.home);
  } catch {
    d.holds.closeAdmission();
    d.fences.closeAdmission();
  }
  const records = () => {
    if (!store) throw failure();
    return store;
  };
  const capture = (id: string) => {
    const cell = d.cells.record(id);
    if (!cell) throw failure();
    return ComputerResetSource.parse({
      ...captureComputerResetSource(cell),
      browser: d.browser.resetSource(id),
    });
  };
  const keysAbsent = async (record: ComputerResetRecord) =>
    !(await d.keyd.cell(record.oldCellId)) &&
    (!record.source.browser || !(await d.keyd.cell(record.source.browser.id)));
  const inspectFresh = async (record: ComputerResetRecord) => {
    const cell = d.cells.record(record.newCellId);
    if (!cell && d.cells.hasStoredIdentity(record.newCellId)) return "foreign" as const;
    const physical = await d.cells.inspectReplacement(record.newCellId);
    if (!cell && physical !== "absent") return "foreign" as const;
    return physical === "absent" && cell ? ("owned" as const) : physical;
  };
  const oldAbsent = async (record: ComputerResetRecord) => {
    try {
      return (
        d.runner.resetTaskDrained(record.oldCellId) &&
        !d.cells.hasStoredIdentity(record.oldCellId) &&
        !d.cells.record(record.oldCellId) &&
        d.browser.resetRetired(record.oldCellId, record.source.browser) &&
        (await keysAbsent(record)) &&
        (await computerResetResourcesAbsent(d.docker, record))
      );
    } catch {
      return false;
    }
  };
  const owner = new ComputerResetOwner({
    store: {
      read: (id) => records().read(id),
      list: () => records().list(),
      write: (row) => records().write(row),
    },
    allocateId: d.allocateId ?? ulid,
    capture,
    hold: (old, fresh, request) => {
      d.holds.hold(old, fresh, request);
      d.cells.holdReplacement(fresh);
    },
    expectedRequests: () => d.holds.records(),
    closeAdmission: () => {
      d.holds.closeAdmission();
      d.fences.closeAdmission();
    },
    inspectFresh,
    oldAbsent,
    retireOld: async (record) => {
      // Do not start even the ordinary Stop/browser cleanup path until the captured graph is owned.
      await verifyComputerResetResources(d.docker, record);
      if (!(await d.runner.retireForReset(record.oldCellId))) throw failure();
      await d.cells.retireReset(record, () =>
        d.browser.retireReset(record.oldCellId, record.source.browser, async () => {
          if (!d.runner.resetTaskDrained(record.oldCellId) || !(await keysAbsent(record)))
            throw failure();
          await retireComputerResetResources(d.docker, record);
          if (!(await keysAbsent(record))) throw failure();
        }),
      );
    },
    createFresh: async (record) => {
      if (!d.available()) throw failure();
      await d.cells.create({ id: record.newCellId, scale: record.source.scale });
      const deadline = Date.now() + (d.readyTimeoutMs ?? 180000);
      for (;;) {
        if (!d.available()) throw failure();
        const cell = d.cells.get(record.newCellId);
        if (cell?.state === "ready" && !cell.paused && (await inspectFresh(record)) === "ready")
          return;
        if (!cell || cell.state === "failed" || cell.state === "removed" || Date.now() >= deadline)
          throw failure();
        await sleep(20);
      }
    },
    retireFresh: async (record) => {
      const result = await d.cells.retireReplacement(record.newCellId, true);
      if (!result.absent || !result.revoked || (await d.keyd.cell(record.newCellId)))
        throw failure();
    },
    publish: (record) => {
      if (d.stopping?.()) throw failure();
      d.holds.publish(record);
      try {
        d.cells.publishReplacement(record.newCellId);
      } catch (error) {
        d.holds.hold(record.oldCellId, record.newCellId, record.requestId);
        throw error;
      }
    },
  });
  return {
    restoreReady: () => owner.restoreReady(),
    status: (old: string, request: string) => owner.status(old, request),
    reset: (old: string, input: ComputerResetRequest) => {
      if (!d.available()) return Promise.reject(failure());
      try {
        const request = ComputerResetRequest.parse(input);
        // Invalid/missing source records must not leave new durable holds with no transaction.
        if (!owner.status(old, request.requestId)) capture(old);
        return owner.reset(old, request);
      } catch {
        return Promise.reject(failure());
      }
    },
  };
}
