import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("scoped parent recovery ownership", () => {
  it("attempts skipped parents and later valid parents despite an earlier child failure", async () => {
    const { cells, stop, ids, store, docker } = await fixture(3);
    const broken = ids.slice(0, 2);
    const records = broken.map((id) => store.get(id));
    for (const id of broken) writeFileSync(join(store.folder(id), "cell.json"), "{broken");
    stop.mockImplementation(async (id) => {
      if (id === broken[0]) throw new Error("first child retirement failed");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(cells.reconcile()).rejects.toThrow("browser shutdown");
    expect(new Set(stop.mock.calls.map(([id]) => id))).toEqual(new Set(ids));
    for (const record of records) {
      expect(docker.state.containers.get(record?.docker.desktop ?? "")?.running).toBe(false);
      expect(docker.state.containers.get(record?.docker.gate ?? "")?.running).toBe(false);
    }
    await waitFor(() => cells.get(ids[2] as string)?.state === "ready");
    expect(ids.map((id) => cells.browserAvailable(id))).toEqual([false, false, false]);
  });

  it("overlapping old success cannot clear a newer inventory failure", async () => {
    const { cells, stop, ids, store } = await fixture();
    const id = ids[0] as string;
    const drain = Promise.withResolvers<void>();
    stop.mockImplementationOnce(() => drain.promise);
    const older = cells.reconcile();
    vi.spyOn(store, "inventory").mockImplementationOnce(() => {
      throw new Error("new discovery failed");
    });
    const newer = cells.reconcile().catch((error: unknown) => error);
    expect(cells.browserAvailable(id)).toBe(false);
    drain.resolve();
    await older;
    expect(await newer).toEqual(new Error("new discovery failed"));
    expect(cells.browserAvailable(id)).toBe(false);
    await cells.reconcile();
    await waitFor(() => cells.browserAvailable(id));
  });

  it("discovery failure waits for every known owner despite an early rejection", async () => {
    const { cells, stop, ids, store } = await fixture(2);
    const drain = Promise.withResolvers<void>();
    stop.mockImplementation((id) =>
      id === ids[0] ? Promise.reject(new Error("first failed")) : drain.promise,
    );
    vi.spyOn(store, "inventory").mockImplementationOnce(() => {
      throw new Error("discovery failed");
    });
    let settled = false;
    const pending = cells.reconcile().then(
      () => {
        settled = true;
        return "resolved";
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(new Set(stop.mock.calls.map(([id]) => id))).toEqual(new Set(ids));
      expect(settled).toBe(false);
    } finally {
      drain.resolve();
    }
    expect(await pending).toEqual(new Error("discovery failed"));
    expect(ids.map((id) => cells.browserAvailable(id))).toEqual([false, false]);
  });

  it("a later ordinary cleanup cannot erase a required per-parent retirement rejection", async () => {
    const { cells, stop, ids, store, docker } = await fixture();
    const id = ids[0] as string;
    const record = store.get(id);
    const parent = Promise.withResolvers<void>();
    const child = Promise.withResolvers<void>();
    stop
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => child.promise)
      .mockResolvedValue(undefined);
    const path = `GET /containers/${record?.docker.desktop}/json`;
    docker.state.holds.set(path, parent.promise);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const recovery = cells.reconcile().then(
      () => "resolved",
      () => "rejected",
    );
    let later: Promise<void> | undefined;
    try {
      await waitFor(() => stop.mock.calls.length >= 2);
      child.reject(new Error("required later retirement failed"));
      await new Promise((resolve) => setImmediate(resolve));
      later = cells.withLifecycle(id, async () => {});
      await new Promise((resolve) => setImmediate(resolve));
      parent.resolve();
      const outcome = await recovery;
      await later;
      expect({ outcome, admitted: cells.browserAvailable(id) }).toEqual({
        outcome: "rejected",
        admitted: false,
      });
    } finally {
      child.resolve();
      parent.resolve();
      docker.state.holds.delete(path);
      await recovery;
      await later;
    }
  });
});
