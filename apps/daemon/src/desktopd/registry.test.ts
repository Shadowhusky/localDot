import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { FakeOrchestrator } from "../cells/testing/fake-orchestrator.ts";
import { type CellSummary, NO_STREAM } from "../cells/types.ts";
import { monotonicClock } from "../clock.ts";
import { DesktopdRegistry } from "./registry.ts";
import { FakeDesktopd } from "./testing/fake-desktopd.ts";

describe("DesktopdRegistry", () => {
  it("keeps one client per cell while it is ready and drops it, clock sync included, when it leaves", () => {
    const cells = new FakeOrchestrator();
    const fake = new FakeDesktopd();
    const registry = new DesktopdRegistry(cells, monotonicClock(), fake.fetchImpl);
    const cell: CellSummary = {
      id: ulid(),
      state: "ready",
      scale: 2,
      createdAt: "",
      stream: NO_STREAM,
    };
    cells.emit(cell);
    cells.endpointsById.set(cell.id, {
      desktopd: { baseUrl: "http://127.0.0.1:1", token: fake.token },
      stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" },
    });
    const first = registry.for(cell.id);
    expect(first).toBeDefined();
    expect(registry.for(cell.id)).toBe(first);
    const stop = vi.spyOn(first?.clocks as NonNullable<typeof first>["clocks"], "stop");
    cells.emit({ ...cell, state: "stopped" });
    expect(stop).toHaveBeenCalled();
    expect(registry.for(cell.id)).not.toBe(first);
    registry.dispose();
  });
});
