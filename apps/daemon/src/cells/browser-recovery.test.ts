import { describe, expect, it, vi } from "vitest";
import { BrowserRecovery } from "./browser-recovery.ts";

const healthy = { online: true, audit: { ok: true } };

describe("browser admission follows credential recovery", () => {
  it("binds readiness to the recovered boot and snapshots mutable health", async () => {
    const pending = Promise.withResolvers<void>();
    const reconcile = vi.fn(async () => {}).mockImplementationOnce(() => pending.promise);
    const owner = new BrowserRecovery({ reconcile });
    const health = { ...healthy, bootId: "one" };
    const work = owner.recover(health);
    health.bootId = "two";
    expect(owner.availableFor("one")).toBe(false);
    pending.resolve();
    await work;
    expect(owner.availableFor("one")).toBe(true);
    expect(owner.availableFor("two")).toBe(false);
    const next = owner.recover(health);
    expect(owner.availableFor("one")).toBe(false);
    await next;
    expect(owner.availableFor("two")).toBe(true);
    await owner.close();
    expect(owner.availableFor("two")).toBe(false);
  });
  // The daemon's startup recovery used to close admission for good when keyd's first healthy
  // report came in before it: no later change in health opened it again.
  it("goes by the latest health heard when a recovery starts without any", async () => {
    const owner = new BrowserRecovery({ reconcile: async () => {} });
    await owner.recover();
    expect(owner.available).toBe(false);
    const health = { ...healthy, bootId: "one" };
    await owner.recover(health);
    health.online = false;
    await owner.recover();
    expect(owner.availableFor("one")).toBe(true);
    await owner.recover({ online: false });
    await owner.recover();
    expect(owner.available).toBe(false);
  });
  it("is closed until actual recovery of healthy keyd finishes", async () => {
    const result = Promise.withResolvers<void>();
    const reconcile = vi.fn(() => result.promise);
    const owner = new BrowserRecovery({ reconcile });
    expect(owner.available).toBe(false);
    const pending = owner.recover(healthy);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(owner.available).toBe(false);
    result.resolve();
    await pending;
    expect(owner.available).toBe(true);
  });

  it.each([{ online: false }, { online: true }, { online: true, audit: { ok: false } }])(
    "immediately fences on unavailable credentials and stays fenced after cleanup: %j",
    async (health) => {
      const owner = new BrowserRecovery({ reconcile: async () => {} });
      await owner.recover(healthy);
      const pending = owner.recover(health);
      expect(owner.available).toBe(false);
      await pending;
      expect(owner.available).toBe(false);
    },
  );

  it("does not let an old healthy recovery supersede a newer failed one", async () => {
    const first = Promise.withResolvers<void>();
    const reconcile = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockRejectedValueOnce(new Error("uncertain containment"));
    const owner = new BrowserRecovery({ reconcile });
    const old = owner.recover(healthy);
    await expect(owner.recover(healthy)).rejects.toThrow("uncertain containment");
    first.resolve();
    await old;
    expect(owner.available).toBe(false);
  });

  it("allows a verified retry after failure and never trusts a mutable health reference", async () => {
    const pending = Promise.withResolvers<void>();
    const reconcile = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(undefined);
    const owner = new BrowserRecovery({ reconcile });
    await expect(owner.recover(healthy)).rejects.toThrow("offline");
    const changed = { online: true, audit: { ok: false } };
    const work = owner.recover(changed);
    changed.audit.ok = true;
    pending.resolve();
    await work;
    expect(owner.available).toBe(false);
    await owner.recover(healthy);
    expect(owner.available).toBe(true);
  });

  it("shutdown fences immediately, drains once and rejects stale reopen attempts", async () => {
    const drain = Promise.withResolvers<void>();
    const stale = Promise.withResolvers<void>();
    const reconcile = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => drain.promise);
    const owner = new BrowserRecovery({ reconcile });
    await owner.recover(healthy);
    const old = owner.recover(healthy);
    const closed = owner.close();
    expect(owner.available).toBe(false);
    expect(owner.close()).toBe(closed);
    stale.resolve();
    await old;
    await owner.recover(healthy);
    expect(reconcile).toHaveBeenCalledTimes(3);
    drain.resolve();
    await closed;
    expect(owner.available).toBe(false);
  });
});
