import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserRecovery } from "./browser-recovery.ts";
import { DockerClient } from "./docker.ts";
import { CellOrchestrator } from "./orchestrator.ts";
import { CellStore } from "./store.ts";
import { startFakeDocker } from "./testing/fake-docker.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors);
});

async function waitFor(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

async function fixture(count = 1) {
  const home = mkdtempSync(join(tmpdir(), "parent-browser-review-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const docker = await startFakeDocker();
  cleanup.push(() => docker.close());
  const stop = vi.fn(async (_id: string) => {});
  const remove = vi.fn(async (_id: string, _options?: { purgeProfile?: boolean }) => {});
  const store = new CellStore(home);
  const cells = new CellOrchestrator({
    store,
    docker: new DockerClient(docker.socketPath),
    images: { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" },
    browser: { stop, remove, reservedKeydPorts: () => [4785] },
    probeDesktopd: async () => ({
      ok: true,
      scale: 2,
      display: ":1",
      screen: { w: 2560, h: 1600 },
      hidpi: {
        ok: true,
        expected: { windowScalingFactor: 2, xftDpi: 96 },
        windowScalingFactor: 2,
        xftDpi: 96,
      },
    }),
    probeStream: async () => true,
    watchEveryMs: 0,
    sleep: async () => {},
    readyTimeoutMs: 1000,
  });
  cleanup.push(() => cells.dispose());
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const { id } = await cells.create({ scale: 2 });
    ids.push(id);
    await waitFor(() => cells.get(id)?.state === "ready" && cells.browserAvailable(id));
  }
  stop.mockClear();
  remove.mockClear();
  return { cells, stop, remove, ids, store, docker };
}

describe("independent parent browser ownership", () => {
  it("reconcile fences every current browser before a failing inventory read", async () => {
    const { cells, stop, ids, store } = await fixture(2);
    vi.spyOn(store, "inventory").mockImplementationOnce(() => {
      throw new Error("fixture disk read failed");
    });
    await expect(cells.reconcile()).rejects.toThrow();
    expect(ids.map((id) => cells.browserAvailable(id))).toEqual([false, false]);
    expect(new Set(stop.mock.calls.map(([id]) => id))).toEqual(new Set(ids));
  });

  it("reconcile does not leave later owners admitted behind an earlier browser drain", async () => {
    const { cells, stop, ids } = await fixture(2);
    const drain = Promise.withResolvers<void>();
    stop.mockImplementation(() => drain.promise);
    const pending = cells.reconcile();
    try {
      await waitFor(() => stop.mock.calls.length > 0);
      expect(ids.map((id) => cells.browserAvailable(id))).toEqual([false, false]);
      expect(new Set(stop.mock.calls.map(([id]) => id))).toEqual(new Set(ids));
    } finally {
      drain.resolve();
      await pending;
    }
  });

  it("reconcile waits for the child of an unreadable parent record before resolving", async () => {
    const { cells, stop, ids, store } = await fixture();
    const id = ids[0] as string;
    const drain = Promise.withResolvers<void>();
    stop.mockImplementation(() => drain.promise);
    writeFileSync(join(store.folder(id), "cell.json"), "{incomplete");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let settled = false;
    const pending = cells.reconcile().finally(() => {
      settled = true;
    });
    try {
      await waitFor(() =>
        logged.mock.calls.some(([message]) =>
          String(message).includes("keyd closed the cell and its containers were stopped"),
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(stop).toHaveBeenCalledWith(id);
      expect(cells.browserAvailable(id)).toBe(false);
      expect(settled).toBe(false);
    } finally {
      drain.resolve();
      await pending;
    }
  });

  it("parent failure still waits for independent child drain", async () => {
    const { cells, stop, ids } = await fixture();
    const drain = Promise.withResolvers<void>();
    stop.mockImplementation(() => drain.promise);
    const entered = Promise.withResolvers<void>();
    let settled = false;
    const pending = cells
      .withLifecycle(ids[0] as string, async () => {
        entered.resolve();
        throw new Error("parent operation failed");
      })
      .then(
        () => {
          settled = true;
          return "unexpected success";
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    try {
      await entered.promise;
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(cells.browserAvailable(ids[0] as string)).toBe(false);
    } finally {
      drain.resolve();
    }
    expect(await pending).toEqual(new Error("parent operation failed"));
  });

  it.each([false, true])(
    "reconcile refuses success when child retirement rejects; unreadable parent=%s",
    async (unreadable) => {
      const { cells, stop, ids, store } = await fixture();
      const id = ids[0] as string;
      if (unreadable) writeFileSync(join(store.folder(id), "cell.json"), "{incomplete");
      stop.mockRejectedValue(new Error("retirement could not be confirmed"));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await cells.reconcile().then(
        () => "resolved",
        () => "rejected",
      );
      expect(stop).toHaveBeenCalledWith(id);
      expect(cells.browserAvailable(id)).toBe(false);
      expect(result).toBe("rejected");
    },
  );

  it("a throwing browser stop cannot prevent physical parent containment", async () => {
    const { cells, stop, ids, store, docker } = await fixture();
    const id = ids[0] as string;
    const record = store.get(id);
    expect(record).toBeDefined();
    stop.mockImplementationOnce(() => {
      throw new Error("private fixture failure");
    });
    await expect(cells.stop(id)).rejects.toThrow(/^browser shutdown could not be confirmed/);
    expect(cells.browserAvailable(id)).toBe(false);
    expect(docker.state.containers.get(record?.docker.desktop ?? "")?.running).toBe(false);
    expect(docker.state.containers.get(record?.docker.gate ?? "")?.running).toBe(false);
  });

  it("home purge cannot implicitly purge a browser profile even after a queued stop", async () => {
    const { cells, remove, ids } = await fixture();
    const id = ids[0] as string;
    const stopped = cells.stop(id);
    const removed = cells.remove(id, { purgeHome: true });
    await stopped;
    await removed;
    expect(remove.mock.calls).toEqual([[id, { purgeProfile: false }]]);
    expect(cells.get(id)).toBeUndefined();
  });

  it("failed terminal recovery stays terminal and returns the same rejected drain", async () => {
    const drain = Promise.withResolvers<void>();
    const reconcile = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => drain.promise);
    const owner = new BrowserRecovery({ reconcile });
    await owner.recover({ online: true, audit: { ok: true } });
    expect(owner.available).toBe(true);
    const closing = owner.close();
    const result = closing.catch((error: unknown) => error);
    expect(owner.available).toBe(false);
    drain.reject(new Error("unconfirmed browser retirement"));
    expect(await result).toEqual(new Error("unconfirmed browser retirement"));
    expect(owner.close()).toBe(closing);
    await owner.recover({ online: true, audit: { ok: true } });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(owner.available).toBe(false);
  });

  it("an older failed recovery cannot revoke the confirmed latest healthy decision", async () => {
    const stale = Promise.withResolvers<void>();
    const reconcile = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(undefined);
    const owner = new BrowserRecovery({ reconcile });
    const old = owner.recover({ online: false }).catch((error: unknown) => error);
    await owner.recover({ online: true, audit: { ok: true } });
    expect(owner.available).toBe(true);
    stale.reject(new Error("old failed result"));
    expect(await old).toEqual(new Error("old failed result"));
    expect(owner.available).toBe(true);
  });
});
