import { ulid } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../agent/session.ts";
import { Transfers } from "../agent/transfers.ts";
import type { CellSummary } from "../cells/types.ts";
import { quarantineAccess } from "./quarantine-access.ts";

function fixture() {
  const id = ulid(),
    transfers = new Transfers();
  let endpoint = { baseUrl: "http://127.0.0.1:5000", token: "x".repeat(43) };
  const cell: CellSummary = {
    id,
    state: "ready",
    scale: 1,
    createdAt: "2026-10-06T00:00:00Z",
    stream: { connection: "none", viewers: 0, lastUpstreamAt: null },
  };
  const session = new AgentSession(ulid(), id, "file release", {
    append() {
      return { seq: 1, t: 1 } as never;
    },
  });
  let active: AgentSession | undefined;
  const deps = {
    available: () => true,
    cell: () => cell,
    endpoint: () => endpoint,
    session: () => active,
    busy: () => false,
    transfers,
  };
  return {
    id,
    transfers,
    cell,
    session,
    deps,
    access: () => quarantineAccess(deps, id, new AbortController().signal),
    activate: () => {
      active = session;
      return session.beginBrain();
    },
    replace: () => {
      endpoint = { ...endpoint, token: "y".repeat(43) };
    },
  };
}
describe("user file release ownership", () => {
  it("allows a ready computer without a task and pins its desktop endpoint", async () => {
    const f = fixture(),
      access = f.access();
    expect(access).toBeDefined();
    access?.check();
    f.replace();
    expect(() => access?.check()).toThrow();
    access?.release();
    await f.transfers.wait(f.id);
  });
  it("cancels an agent-era release and keeps takeover waiting for physical drain", async () => {
    const f = fixture();
    f.activate();
    const access = f.access();
    const takeover = f.session.takeover("fixture", "take control");
    expect(access?.signal.aborted).toBe(true);
    expect(f.session.manualControl).toBe("waiting");
    access?.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.session.manualControl).toBe("ready");
    const stopped = expect(takeover).rejects.toThrow("no longer active");
    f.session.stop();
    await stopped;
    await f.transfers.wait(f.id);
  });
  it("allows release during manual takeover and drains it before handback", async () => {
    const f = fixture();
    f.activate();
    const takeover = f.session.takeover("fixture", "user download");
    await new Promise((resolve) => setImmediate(resolve));
    const access = f.access();
    expect(access).toBeDefined();
    access?.check();
    let returned = false;
    const ticket = f.session.pendingTakeover;
    if (!ticket) throw new Error("expected a current takeover ticket");
    const handback = f.session.handback(ticket, undefined).then((value) => {
      returned = value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(access?.signal.aborted).toBe(true);
    expect(returned).toBe(false);
    access?.release();
    await handback;
    await takeover;
    expect(returned).toBe(true);
    f.session.stop();
    await f.transfers.wait(f.id);
  });
  it.each(["paused", "fenced", "replacementPending"] as const)(
    "rejects %s computers",
    async (flag) => {
      const f = fixture();
      if (flag === "fenced") f.cell.fenced = { revision: 1 };
      else f.cell[flag] = true;
      expect(() => f.access()).toThrow();
      await f.transfers.wait(f.id);
    },
  );
  it("shares the agent shutdown transfer fence", async () => {
    const f = fixture(),
      access = f.access();
    f.transfers.close();
    expect(access?.signal.aborted).toBe(true);
    expect(() => f.access()).toThrow();
    access?.release();
    await f.transfers.settled();
  });
});
