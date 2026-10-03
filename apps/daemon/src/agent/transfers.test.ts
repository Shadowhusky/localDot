import { describe, expect, it } from "vitest";
import { Transfers } from "./transfers.ts";

describe("owned user file transfers", () => {
  it("cancels immediately but waits for actual transport settlement", async () => {
    const transfers = new Transfers();
    const lease = transfers.acquire("cell", [], () => {});
    let settled = false;
    const wait = transfers.wait("cell").then(() => {
      settled = true;
    });
    transfers.abortCell("cell");
    expect(lease.signal.aborted).toBe(true);
    expect(() => lease.check()).toThrow();
    await Promise.resolve();
    expect(settled).toBe(false);
    lease.release();
    lease.release();
    await wait;
    expect(settled).toBe(true);
  });
  it("refuses admission after closing and does not treat caller cancellation as settlement", async () => {
    const transfers = new Transfers(),
      caller = new AbortController();
    const lease = transfers.acquire("a", [caller.signal], () => {});
    caller.abort();
    await expect(transfers.wait("a", caller.signal)).rejects.toBeDefined();
    transfers.close();
    expect(() => transfers.acquire("b", [], () => {})).toThrow();
    lease.release();
    await transfers.wait("a");
  });
  it("checks current cell control again after admission", () => {
    const transfers = new Transfers();
    let valid = true;
    const lease = transfers.acquire("a", [], () => {
      if (!valid) throw new Error("changed");
    });
    valid = false;
    expect(() => lease.check()).toThrow("changed");
    lease.release();
  });
});
