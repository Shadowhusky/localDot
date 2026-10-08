import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserDownloadBinding } from "../../../../packages/protocol/src/browser-downloads.ts";
import type { BrowserScope } from "./client.ts";
import type { BrowserDownloadCollector } from "./download-collector.ts";
import { BrowserDownloadPump } from "./download-pump.ts";

const pumps: BrowserDownloadPump[] = [];
afterEach(async () => {
  for (const pump of pumps.splice(0)) {
    pump.stop();
    await pump.settled;
  }
});
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await sleep(1);
  expect(check()).toBe(true);
}
function fixture() {
  const abort = new AbortController();
  const scope = { signal: abort.signal, check: vi.fn() };
  const binding: BrowserDownloadBinding = {
    holder: "user",
    sessionId: ulid(),
    permit: {
      parentCellId: ulid(),
      browserCellId: ulid(),
      instance: randomUUID(),
      revision: 1,
      requestId: ulid(),
    },
  };
  const client = {
    armDownloads: vi.fn(async (_binding: BrowserDownloadBinding, scope: BrowserScope) =>
      scope.check(),
    ),
    downloads: vi.fn(),
    readDownload: vi.fn(),
    acknowledgeDownload: vi.fn(),
    close: vi.fn(),
  };
  const collector = { collect: vi.fn<BrowserDownloadCollector["collect"]>(async () => []) };
  const start = () => {
    const pump = new BrowserDownloadPump({ client, collector, binding, scope, pollMs: 1 });
    pumps.push(pump);
    return pump;
  };
  return { abort, scope, binding, client, collector, start };
}

describe("session-owned download polling", () => {
  it("does not collect until arming confirms the exact binding", async () => {
    const f = fixture();
    const armed = Promise.withResolvers<void>();
    f.client.armDownloads.mockImplementation(async () => armed.promise);
    const pump = f.start();
    await sleep(1);
    expect(f.collector.collect).not.toHaveBeenCalled();
    armed.resolve();
    await pump.ready;
    await until(() => f.collector.collect.mock.calls.length > 0);
    expect(f.client.armDownloads.mock.calls[0]?.[0]).toEqual(f.binding);
    expect(f.collector.collect.mock.calls[0]?.[1]).toEqual(f.binding);
  });

  it("keeps failed collection retries under the same grant without rearming", async () => {
    const f = fixture();
    f.collector.collect.mockRejectedValueOnce(new Error("lost acknowledgement"));
    const pump = f.start();
    await pump.ready;
    await until(() => f.collector.collect.mock.calls.length >= 2);
    pump.stop();
    await pump.settled;
    expect(f.client.armDownloads).toHaveBeenCalledOnce();
    for (const call of f.collector.collect.mock.calls) expect(call[1]).toEqual(f.binding);
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it("waits for an arming transport to retire after cancellation", async () => {
    const f = fixture();
    const physical = Promise.withResolvers<void>();
    f.client.armDownloads.mockImplementation(async (_binding, scope) => {
      await physical.promise;
      scope.check();
    });
    const pump = f.start();
    pump.stop();
    let settled = false;
    void pump.settled.then(() => {
      settled = true;
    });
    await sleep(1);
    expect(settled).toBe(false);
    expect(f.client.close).not.toHaveBeenCalled();
    physical.resolve();
    await expect(pump.ready).rejects.toThrow();
    await pump.settled;
    expect(f.collector.collect).not.toHaveBeenCalled();
  });

  it("retains a cancelled collector until its source has physically drained", async () => {
    const f = fixture();
    const physical = Promise.withResolvers<void>();
    f.collector.collect.mockImplementation(async (_client, _binding, scope) => {
      await physical.promise;
      scope.check();
      return [];
    });
    const pump = f.start();
    await pump.ready;
    pump.stop();
    let settled = false;
    void pump.settled.then(() => {
      settled = true;
    });
    await sleep(1);
    expect(settled).toBe(false);
    expect(f.client.close).not.toHaveBeenCalled();
    physical.resolve();
    await pump.settled;
    expect(f.client.close).toHaveBeenCalledOnce();
    expect(f.collector.collect).toHaveBeenCalledOnce();
  });

  it("aborts idle polling immediately when the session lifetime ends", async () => {
    const f = fixture();
    const pump = f.start();
    await pump.ready;
    f.abort.abort();
    await pump.settled;
    const count = f.collector.collect.mock.calls.length;
    await sleep(3);
    expect(f.collector.collect).toHaveBeenCalledTimes(count);
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it("does not hide arming failure as a successful browser grant", async () => {
    const f = fixture();
    f.client.armDownloads.mockRejectedValue(new Error("arming refused"));
    const pump = f.start();
    await expect(pump.ready).rejects.toThrow("arming refused");
    await pump.settled;
    expect(f.collector.collect).not.toHaveBeenCalled();
    expect(f.client.close).toHaveBeenCalledOnce();
  });
});
