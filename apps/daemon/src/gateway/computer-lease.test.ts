import { describe, expect, it } from "vitest";
import { ComputerLease, ComputerLeaseRevoked } from "./computer-lease.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("the computer's lease", () => {
  it("serves one task at a time, first come first served", async () => {
    const lease = new ComputerLease();
    const order: string[] = [];
    const a = await lease.acquire("a");
    const b = lease.acquire("b").then((grant) => {
      order.push("b");
      return grant;
    });
    const c = lease.acquire("c").then((grant) => {
      order.push("c");
      return grant;
    });
    await settle();
    expect(lease.holder).toBe("a");
    expect(lease.waiting()).toEqual(["b", "c"]);
    a.release();
    (await b).release();
    (await c).release();
    expect(order).toEqual(["b", "c"]);
    expect(lease.holder).toBeUndefined();
    expect(lease.last).toBe("c");
  });

  it("puts the user's control ahead of every waiting task", async () => {
    const lease = new ComputerLease();
    const a = await lease.acquire("a");
    const b = lease.acquire("b");
    const user = lease.acquire("c", { user: true });
    await settle();
    expect(lease.waiting()).toEqual(["c", "b"]);
    a.release();
    const held = await user;
    expect(held.user).toBe(true);
    expect(lease.userHolds).toBe(true);
    held.release();
    (await b).release();
  });

  it("grants a session that already holds the computer again at once, and frees it after both", async () => {
    const lease = new ComputerLease();
    const action = await lease.acquire("a");
    const waiting = lease.acquire("b");
    const handOff = await lease.acquire("a", { user: true });
    action.release();
    await settle();
    expect(lease.holder).toBe("a");
    handOff.release();
    const next = await waiting;
    expect(next.sessionId).toBe("b");
    next.release();
  });

  it("lets a waiting task leave, and ignores a second release", async () => {
    const lease = new ComputerLease();
    const a = await lease.acquire("a");
    const leaving = new AbortController();
    const b = lease.acquire("b", { signal: leaving.signal });
    const c = lease.acquire("c");
    leaving.abort();
    await expect(b).rejects.toBeDefined();
    expect(lease.waiting()).toEqual(["c"]);
    a.release();
    a.release();
    const next = await c;
    expect(lease.holder).toBe("c");
    next.release();
  });

  it("revokes a stopped task's waits and grants, and hands the computer on", async () => {
    const lease = new ComputerLease();
    await lease.acquire("a");
    const again = lease.acquire("b");
    const other = lease.acquire("c");
    lease.revoke("b");
    await expect(again).rejects.toBeInstanceOf(ComputerLeaseRevoked);
    lease.revoke("a");
    const next = await other;
    expect(next.sessionId).toBe("c");
    expect(lease.last).toBe("c");
    next.release();
  });

  it("tells its listeners of every change", async () => {
    const lease = new ComputerLease();
    let changes = 0;
    const stop = lease.subscribe(() => changes++);
    const a = await lease.acquire("a");
    a.release();
    stop();
    (await lease.acquire("b")).release();
    expect(changes).toBe(2);
  });
});
