import type { KeydStatus } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cameUp, KeydMonitor } from "./monitor.ts";
import { FAKE_SEAL_KEY } from "./testing/fake-keyd.ts";

const status = (bootId = "boot-1"): KeydStatus => ({
  bootId,
  version: "test",
  sealKey: FAKE_SEAL_KEY,
  cells: 0,
  secrets: 0,
  limits: { perTaskUSD: 5, perDayUSD: 20 },
  day: { date: "2026-10-02", spentUSD: 0 },
  audit: { ok: true },
  hairpin: { state: "active", source: "nat-pmp", addresses: 1 },
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("credential service health polling", () => {
  it("shares an in-flight refresh instead of letting old replies overwrite a new boot", async () => {
    const reply = Promise.withResolvers<KeydStatus>();
    const read = vi.fn(() => reply.promise);
    const monitor = new KeydMonitor({ status: read });
    const one = monitor.refresh();
    const two = monitor.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    reply.resolve(status());
    expect(await one).toEqual(await two);
    await monitor.refresh();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reports audit and hairpin changes, but ignores a polling timestamp alone", async () => {
    const read = vi.fn<() => Promise<KeydStatus>>().mockResolvedValue(status());
    const monitor = new KeydMonitor({ status: read });
    const listener = vi.fn();
    const unsubscribe = monitor.subscribe(listener);
    await monitor.refresh();
    read.mockResolvedValue({
      ...status(),
      hairpin: { state: "active", source: "nat-pmp", addresses: 1, checkedAt: "now" },
    });
    await monitor.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    read.mockResolvedValue({ ...status(), audit: { ok: false, error: "disk full" } });
    await monitor.refresh();
    expect(listener).toHaveBeenCalledTimes(2);
    read.mockResolvedValue({ ...status(), hairpin: undefined });
    expect((await monitor.refresh()).hairpin?.state).toBe("unknown");
    expect(listener).toHaveBeenCalledTimes(3);
    read.mockResolvedValue({ ...status(), hairpin: { state: "off", addresses: 0 } });
    await monitor.refresh();
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    read.mockResolvedValue(status("new-boot"));
    await monitor.refresh();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("says how many keys need entering again without rewiring cells over it", async () => {
    const read = vi.fn<() => Promise<KeydStatus>>().mockResolvedValue(status());
    const monitor = new KeydMonitor({ status: read });
    expect((await monitor.refresh()).reenter).toBe(0);
    const listener = vi.fn();
    monitor.subscribe(listener);
    read.mockResolvedValue({ ...status(), reenter: 2 });
    expect((await monitor.refresh()).reenter).toBe(2);
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops polling and drops a reply that arrives after stop", async () => {
    vi.useFakeTimers();
    const reply = Promise.withResolvers<KeydStatus>();
    const read = vi.fn(() => reply.promise);
    const monitor = new KeydMonitor({ status: read }, 20);
    const listener = vi.fn();
    monitor.subscribe(listener);
    monitor.start();
    monitor.start();
    expect(read).toHaveBeenCalledTimes(1);
    monitor.stop();
    reply.resolve(status());
    await vi.advanceTimersByTimeAsync(100);
    expect(listener).not.toHaveBeenCalled();
    expect(monitor.health.online).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can restart during a pending poll without a stale health result or duplicate timers", async () => {
    vi.useFakeTimers();
    const old = Promise.withResolvers<KeydStatus>();
    const read = vi
      .fn<() => Promise<KeydStatus>>()
      .mockResolvedValue(status("new-boot"))
      .mockReturnValueOnce(old.promise);
    const monitor = new KeydMonitor({ status: read }, 20);
    monitor.start();
    monitor.stop();
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.health.bootId).toBe("new-boot");
    old.resolve(status("old-boot"));
    await vi.advanceTimersByTimeAsync(100);
    expect(monitor.health.bootId).toBe("new-boot");
    expect(read).toHaveBeenCalledTimes(7);
    expect(vi.getTimerCount()).toBe(1);
    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates failing listeners and never logs their error message", async () => {
    const monitor = new KeydMonitor({ status: async () => status() });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    monitor.subscribe(() => {
      throw new Error("sensitive-health-diagnostic");
    });
    monitor.subscribe(async () => {
      throw new Error("sensitive-health-diagnostic");
    });
    const seen = vi.fn();
    monitor.subscribe(seen);
    expect((await monitor.refresh()).online).toBe(true);
    await Promise.resolve();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive-health-diagnostic");
  });

  it("rewires only when the service becomes online or changes its boot", () => {
    const offline = { online: false };
    const online = { online: true, bootId: "one" };
    expect(cameUp(online, offline)).toBe(true);
    expect(cameUp({ ...online, bootId: "two" }, online)).toBe(true);
    expect(cameUp(online, online)).toBe(false);
    expect(cameUp(offline, online)).toBe(false);
  });
});
