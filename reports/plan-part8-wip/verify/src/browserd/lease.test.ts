import { describe, expect, it } from "vitest";
import { Lease } from "./lease.ts";
import { refusedShortcut } from "./shortcuts.ts";

const L1 = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const L2 = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0M";

function fakes(opts: { secret?: string[]; reloadClears?: boolean; clearFails?: boolean } = {}) {
  const calls: string[] = [];
  let secret = [...(opts.secret ?? [])];
  const lease = new Lease({
    clearSelections: async () => {
      calls.push("clear");
      if (opts.clearFails) throw new Error("no X");
    },
    secretPages: async () => {
      calls.push(`scan ${secret.length}`);
      return secret;
    },
    reload: async (page) => {
      calls.push(`reload ${page}`);
      if (opts.reloadClears !== false) secret = secret.filter((p) => p !== page);
    },
    abortAgentCalls: () => calls.push("abort"),
  });
  return { lease, calls };
}

describe("the lease (Review Focus 3)", () => {
  it("starts with the user holding the browser, so nothing serves the agent before the daemon says so", () => {
    expect(fakes().lease.agentMayAct).toBe(false);
  });

  it("takes the screen for the user at once and ends the agent's calls in flight", async () => {
    const { lease, calls } = fakes();
    await lease.set({ holder: "agent", leaseId: L1 });
    expect(lease.agentMayAct).toBe(true);
    const reply = await lease.set({ holder: "user", leaseId: L2 });
    expect(reply.holder).toBe("user");
    expect(lease.agentMayAct).toBe(false);
    expect(calls.at(-1)).toBe("abort");
  });

  it("clears the selections and reloads a page that still holds a password before the agent gets it", async () => {
    const { lease, calls } = fakes({ secret: ["P1"] });
    const reply = await lease.set({ holder: "agent", leaseId: L1 });
    expect(calls).toEqual(["clear", "scan 1", "reload P1", "scan 0"]);
    expect(reply).toEqual({ holder: "agent", leaseId: L1, reloaded: 1, selectionsCleared: true });
  });

  it("keeps the user holding it when a step fails, so the agent never sees the field", async () => {
    const stuck = fakes({ secret: ["P1"], reloadClears: false });
    await expect(stuck.lease.set({ holder: "agent", leaseId: L1 })).rejects.toThrow(/secret field/);
    expect(stuck.lease.agentMayAct).toBe(false);
    const noX = fakes({ clearFails: true });
    await expect(noX.lease.set({ holder: "agent", leaseId: L1 })).rejects.toThrow(/no X/);
    expect(noX.lease.agentMayAct).toBe(false);
  });

  it("applies changes in the order they arrive", async () => {
    const { lease } = fakes({ secret: ["P1"] });
    const back = lease.set({ holder: "agent", leaseId: L1 });
    const take = lease.set({ holder: "user", leaseId: L2 });
    await Promise.all([back, take]);
    expect(lease.holder).toBe("user");
  });
});

describe("refusedShortcut", () => {
  it("refuses DevTools and view-source in any spelling", () => {
    for (const combo of [["F12"], ["Control_L", "Shift_L", "i"], ["ctrl", "shift", "J"], ["ctrl", "u"], ["shift", "ctrl", "c"]])
      expect(refusedShortcut(combo), combo.join("+")).toBe(true);
    for (const combo of [["ctrl", "l"], ["Return"], ["ctrl", "shift", "t"], ["ctrl", "i"], ["u"]])
      expect(refusedShortcut(combo), combo.join("+")).toBe(false);
  });
});
