import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeydHealth } from "../keyd/monitor.ts";
import { BrowserRecovery, credentialsChanged } from "./browser-recovery.ts";

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

describe("a recovery that fails while keyd is healthy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is tried again by itself with backoff until it completes, and says so meanwhile", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-29T08:00:00.000Z") });
    const reconcile = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Docker did not answer"))
      .mockRejectedValueOnce(new Error("Docker did not answer"))
      .mockResolvedValue(undefined);
    const recovered = vi.fn();
    const report = vi.fn();
    const owner = new BrowserRecovery({ reconcile }, { retryMs: [1000, 4000], recovered, report });
    await expect(owner.recover(healthy)).rejects.toThrow("Docker did not answer");
    expect(owner.available).toBe(false);
    expect(owner.pending).toEqual({
      failure: "Docker did not answer",
      retryAt: new Date("2026-10-29T08:00:01.000Z"),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(owner.pending.retryAt).toEqual(new Date("2026-10-29T08:00:05.000Z"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(owner.available).toBe(true);
    expect(owner.pending).toEqual({});
    expect(recovered).toHaveBeenCalledOnce();
    expect(report.mock.calls).toEqual([
      ["browser recovery could not complete (Docker did not answer); trying again by itself"],
      ["browser recovery completed; the web browser may start again"],
    ]);
  });

  it("waits for keyd instead when keyd is what failed, and a newer recovery replaces a retry", async () => {
    vi.useFakeTimers();
    const reconcile = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("keyd offline"))
      .mockRejectedValueOnce(new Error("Docker busy"))
      .mockResolvedValue(undefined);
    const owner = new BrowserRecovery({ reconcile }, { retryMs: [1000] });
    await expect(owner.recover({ online: false })).rejects.toThrow("keyd offline");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcile).toHaveBeenCalledOnce();
    await expect(owner.recover(healthy)).rejects.toThrow("Docker busy");
    await owner.recover(healthy);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(owner.available).toBe(true);
  });

  it("stops retrying once closed", async () => {
    vi.useFakeTimers();
    const reconcile = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Docker busy"))
      .mockResolvedValue(undefined);
    const owner = new BrowserRecovery({ reconcile }, { retryMs: [1000] });
    await expect(owner.recover(healthy)).rejects.toThrow("Docker busy");
    await owner.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(owner.available).toBe(false);
  });
});

describe("which keyd changes restart the browser", () => {
  const up: KeydHealth = { online: true, bootId: "one", audit: { ok: true } };
  it("ignores the hairpin probe and error texts that change every discovery round", () => {
    expect(
      credentialsChanged(
        { ...up, hairpin: { state: "unknown", addresses: 0, error: "read udp4 :49537" } },
        { ...up, hairpin: { state: "unknown", addresses: 0, error: "read udp4 :51697" } },
      ),
    ).toBe(false);
    expect(
      credentialsChanged({ online: false, error: "timeout" }, { online: false, error: "refused" }),
    ).toBe(false);
  });
  const changes: [string, KeydHealth][] = [
    ["went offline", { online: false }],
    ["restarted", { ...up, bootId: "two" }],
    ["lost its audit log", { ...up, audit: { ok: false } }],
  ];
  it.each(changes)("restarts it when keyd %s", (_change, now) => {
    expect(credentialsChanged(now, up)).toBe(true);
    expect(credentialsChanged(up, now)).toBe(true);
  });
});
