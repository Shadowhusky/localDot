import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerClient } from "./docker.ts";
import { CellOrchestrator, type OrchestratorDeps } from "./orchestrator.ts";
import { CellStore } from "./store.ts";
import { startFakeDocker } from "./testing/fake-docker.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function waitFor(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

async function setup(extra: Partial<OrchestratorDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "localdot-parent-browser-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const docker = await startFakeDocker();
  cleanup.push(() => docker.close());
  const stop = vi.fn(async (_parent: string) => {});
  const remove = vi.fn(async (_parent: string, _options?: { purgeProfile?: boolean }) => {});
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
    ...extra,
  });
  cleanup.push(() => cells.dispose());
  const created = await cells.create({ scale: 2 });
  await waitFor(
    () => cells.get(created.id)?.state === "ready" && cells.browserAvailable(created.id),
  );
  stop.mockClear();
  remove.mockClear();
  return { cells, stop, remove, id: created.id, store, docker };
}

describe("parent computer owns its browser lifecycle", () => {
  it("fences the browser immediately and waits for its drain before acknowledging Stop", async () => {
    const test = await setup();
    const barrier = Promise.withResolvers<void>();
    test.stop.mockImplementation(() => barrier.promise);
    let settled = false;
    const operation = test.cells.stop(test.id).then(() => {
      settled = true;
    });
    expect(test.stop).toHaveBeenCalledWith(test.id);
    expect(test.cells.browserAvailable(test.id)).toBe(false);
    await waitFor(() => test.cells.get(test.id)?.state === "stopped");
    expect(settled).toBe(false);
    barrier.resolve();
    await operation;
    expect(settled).toBe(true);
  });

  it("still stops the parent when browser retirement fails and refuses a successful receipt", async () => {
    const test = await setup();
    test.stop.mockRejectedValue(new Error("private-browser-diagnostic"));
    await expect(test.cells.stop(test.id)).rejects.toThrow(
      /^browser shutdown could not be confirmed/,
    );
    expect(test.cells.get(test.id)?.state).toBe("stopped");
    expect(test.cells.browserAvailable(test.id)).toBe(false);
  });

  it("fences a browser while a prior parent operation is still in the queue", async () => {
    const test = await setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const prior = test.cells.withLifecycle(test.id, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    test.stop.mockClear();
    const stopped = test.cells.stop(test.id);
    expect(test.cells.browserAvailable(test.id)).toBe(false);
    expect(test.stop).toHaveBeenCalledWith(test.id);
    release.resolve();
    await prior;
    await stopped;
  });

  it("covers the kill switch's queued pause path and keeps browser admission closed", async () => {
    const test = await setup();
    await test.cells.withLifecycle(test.id, async (controls) => controls.pause());
    expect(test.stop).toHaveBeenCalledWith(test.id);
    expect(test.cells.get(test.id)?.paused).toBe(true);
    expect(test.cells.browserAvailable(test.id)).toBe(false);
  });

  it.each([false, true])(
    "forwards browser profile purge only when explicitly requested: %s",
    async (purge) => {
      const test = await setup();
      await test.cells.remove(test.id, {
        purgeHome: true,
        ...(purge ? { purgeBrowserProfile: true } : {}),
      });
      expect(test.remove).toHaveBeenCalledWith(test.id, { purgeProfile: purge });
      expect(test.cells.get(test.id)).toBeUndefined();
    },
  );

  it("does not acknowledge removal when the browser association could not retire", async () => {
    const test = await setup();
    test.remove.mockRejectedValue(new Error("private-remove-error"));
    await expect(test.cells.remove(test.id)).rejects.toThrow(
      /^browser shutdown could not be confirmed/,
    );
    expect(test.cells.get(test.id)).toBeUndefined();
  });

  it("replacement holds immediately retire browser control and share partial browser port reservations", async () => {
    const test = await setup();
    expect(test.cells.reservedKeydPorts()).toContain(4785);
    test.cells.holdReplacement(test.id);
    expect(test.stop).toHaveBeenCalledWith(test.id);
    expect(test.cells.browserAvailable(test.id)).toBe(false);
  });

  it("retains an uncertain browser fence even if the parent stayed ready, until a successful retry", async () => {
    const test = await setup();
    test.stop.mockRejectedValueOnce(new Error("uncertain stop"));
    await expect(test.cells.withLifecycle(test.id, async () => {})).rejects.toThrow(
      "browser shutdown",
    );
    expect(test.cells.get(test.id)?.state).toBe("ready");
    expect(test.cells.browserAvailable(test.id)).toBe(false);
    await test.cells.withLifecycle(test.id, async () => {});
    expect(test.cells.browserAvailable(test.id)).toBe(true);
  });

  it("does not reopen browser admission while a second lifecycle operation still owns a hold", async () => {
    const test = await setup();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const one = test.cells.withLifecycle(test.id, async () => first.promise);
    const two = test.cells.withLifecycle(test.id, async () => second.promise);
    first.resolve();
    await one;
    expect(test.cells.browserAvailable(test.id)).toBe(false);
    second.resolve();
    await two;
    expect(test.cells.browserAvailable(test.id)).toBe(true);
  });

  it("disposal immediately retires browser owners and permanently closes admission", async () => {
    const test = await setup();
    test.cells.dispose();
    expect(test.stop).toHaveBeenCalledWith(test.id);
    expect(test.cells.browserAvailable(test.id)).toBe(false);
  });

  it("awaits child retirement after inventory failure and requires confirmed recovery to reopen", async () => {
    const test = await setup();
    const drain = Promise.withResolvers<void>();
    test.stop.mockImplementationOnce(() => drain.promise);
    vi.spyOn(test.store, "inventory").mockImplementationOnce(() => {
      throw new Error("inventory unavailable");
    });
    let settled = false;
    const recovering = test.cells.reconcile().catch((error: unknown) => {
      settled = true;
      return error;
    });
    expect(test.cells.browserAvailable(test.id)).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    drain.resolve();
    expect(await recovering).toEqual(new Error("inventory unavailable"));
    expect(test.cells.browserAvailable(test.id)).toBe(false);
    await test.cells.withLifecycle(test.id, async () => {});
    expect(test.cells.browserAvailable(test.id)).toBe(false);
    await test.cells.reconcile();
    await waitFor(() => test.cells.browserAvailable(test.id));
  });

  it("retains recovery uncertainty even when a later per-parent stop succeeded", async () => {
    const test = await setup();
    test.stop.mockRejectedValueOnce(new Error("initial drain uncertain"));
    await expect(test.cells.reconcile()).rejects.toThrow("browser shutdown");
    expect(test.cells.browserAvailable(test.id)).toBe(false);
    await test.cells.reconcile();
    await waitFor(() => test.cells.browserAvailable(test.id));
  });

  it("rejects recovery when the later per-parent drain fails after the initial drain succeeded", async () => {
    const test = await setup();
    test.stop.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("later drain failed"));
    await expect(test.cells.reconcile()).rejects.toThrow("browser shutdown");
    expect(test.cells.browserAvailable(test.id)).toBe(false);
    test.stop.mockResolvedValue(undefined);
    await test.cells.reconcile();
    await waitFor(() => test.cells.browserAvailable(test.id));
  });
});

describe("a browser stop that could not be confirmed doesn't keep the browser closed for good", () => {
  it("tries the computer's unconfirmed browser stop again until it is confirmed", async () => {
    const test = await setup({ browserStopRetryMs: [10] });
    test.stop.mockRejectedValueOnce(new Error("Docker busy"));
    await expect(test.cells.withLifecycle(test.id, async () => {})).rejects.toThrow(
      "browser shutdown",
    );
    expect(test.cells.browserPending(test.id)).toBe("unconfirmed");
    await waitFor(() => test.cells.browserAvailable(test.id));
    expect(test.stop).toHaveBeenCalledTimes(2);
    expect(test.cells.browserPending(test.id)).toBeUndefined();
  });

  it("lets a complete browser recovery lift what a reconcile without keyd left closed", async () => {
    const unconfirmed = vi.fn();
    const test = await setup({ browsersUnconfirmed: unconfirmed, browserStopRetryMs: [60_000] });
    // keyd is not up yet when the daemon reconciles its computers.
    test.stop.mockRejectedValue(new Error("keyd offline"));
    await expect(test.cells.reconcile()).rejects.toThrow("browser shutdown");
    expect(unconfirmed).toHaveBeenCalledOnce();
    await waitFor(() => test.cells.get(test.id)?.state === "ready");
    expect(test.cells.browserAvailable(test.id)).toBe(false);
    expect(test.cells.browserPending(test.id)).toBe("unconfirmed");
    // keyd is back: a browser recovery confirms every browser stopped.
    test.stop.mockResolvedValue(undefined);
    const confirmed = test.cells.confirmBrowsers();
    confirmed();
    expect(test.cells.browserAvailable(test.id)).toBe(true);
  });

  it("keeps closed a browser whose stop failed after that recovery began", async () => {
    const test = await setup({ browserStopRetryMs: [60_000] });
    const confirmed = test.cells.confirmBrowsers();
    test.stop.mockRejectedValueOnce(new Error("uncertain"));
    await expect(test.cells.withLifecycle(test.id, async () => {})).rejects.toThrow(
      "browser shutdown",
    );
    confirmed();
    expect(test.cells.browserAvailable(test.id)).toBe(false);
    test.cells.confirmBrowsers()();
    expect(test.cells.browserAvailable(test.id)).toBe(true);
  });

  it("tells listeners as soon as the browser may start again after a lifecycle operation", async () => {
    const test = await setup();
    const seen: boolean[] = [];
    test.cells.subscribe((cell) => {
      if (cell.id === test.id) seen.push(test.cells.browserAvailable(test.id));
    });
    await test.cells.withLifecycle(test.id, async () => {});
    expect(seen.at(-1)).toBe(true);
  });

  it("leaves to a reconcile under way what only it can confirm", async () => {
    const test = await setup();
    const drain = Promise.withResolvers<void>();
    test.stop.mockImplementationOnce(() => drain.promise);
    const confirmed = test.cells.confirmBrowsers();
    const recovering = test.cells.reconcile();
    confirmed();
    expect(test.cells.browserAvailable(test.id)).toBe(false);
    expect(test.cells.browserPending(test.id)).toBe("stopping");
    drain.resolve();
    await recovering;
    await waitFor(() => test.cells.browserAvailable(test.id));
  });
});
