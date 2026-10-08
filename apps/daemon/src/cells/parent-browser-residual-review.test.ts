import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerClient } from "./docker.ts";
import { CellControlConflict, CellOrchestrator } from "./orchestrator.ts";
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
  const home = mkdtempSync(join(tmpdir(), "parent-browser-residual-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const docker = await startFakeDocker();
  cleanup.push(() => docker.close());
  const stop = vi.fn(async (_id: string) => {});
  const store = new CellStore(home);
  const deps: ConstructorParameters<typeof CellOrchestrator>[0] = {
    store,
    docker: new DockerClient(docker.socketPath),
    images: { desktop: "localdot/desktop:dev", gate: "localdot/gate:dev" },
    browser: { stop, remove: async () => {}, reservedKeydPorts: () => [4785] },
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
  };
  const cells = new CellOrchestrator(deps);
  cleanup.push(() => cells.dispose());
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const { id } = await cells.create({ scale: 2 });
    ids.push(id);
    await waitFor(() => cells.get(id)?.state === "ready" && cells.browserAvailable(id));
  }
  stop.mockClear();
  return { cells, deps, stop, store, ids };
}

describe("operation-owned browser retirement precedence", () => {
  it("preserves the original parent-only error after confirmed child retirement", async () => {
    const { cells, stop, ids } = await fixture();
    const id = ids[0] as string;
    const parentError = new Error("fixture parent failure");
    const result = await cells
      .withLifecycle(id, async () => {
        throw parentError;
      })
      .catch((error: unknown) => error);
    expect(result).toBe(parentError);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cells.browserAvailable(id)).toBe(true);
  });

  it.each(["parent", "child"])(
    "waits for both owners and preserves child conflict when %s rejects first",
    async (first) => {
      const { cells, stop, ids } = await fixture();
      const id = ids[0] as string;
      const parent = Promise.withResolvers<void>();
      const child = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const parentError = new Error("fixture parent private error");
      const childError = new Error("fixture child private error");
      stop.mockImplementationOnce(() => child.promise);
      let settled = false;
      const operation = cells
        .withLifecycle(id, async () => {
          entered.resolve();
          await parent.promise;
        })
        .then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      try {
        await entered.promise;
        if (first === "parent") parent.reject(parentError);
        else child.reject(childError);
        await new Promise((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(cells.browserAvailable(id)).toBe(false);
        if (first === "parent") child.reject(childError);
        else parent.reject(parentError);
        const error = await operation;
        expect(error).toBeInstanceOf(CellControlConflict);
        expect(error).toHaveProperty(
          "message",
          "browser shutdown could not be confirmed; retry Stop",
        );
        expect(error).not.toBe(parentError);
        expect(error).not.toBe(childError);
        expect(cells.browserAvailable(id)).toBe(false);
      } finally {
        parent.resolve();
        child.resolve();
        await operation;
      }
    },
  );

  it.each([false, true])(
    "continues later parents and distinguishes a record read failure with child failure=%s",
    async (childFails) => {
      const { cells, deps, stop, store, ids } = await fixture(2);
      cells.dispose();
      await new Promise((resolve) => setImmediate(resolve));
      const calls = new Map<string, number>();
      stop.mockClear();
      stop.mockImplementation(async (id) => {
        const n = (calls.get(id) ?? 0) + 1;
        calls.set(id, n);
        if (childFails && id === ids[0] && n === 2) throw new Error("required child failed");
      });
      const get = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementation((id) => {
        if (id === ids[0]) throw new Error("parent record read failed");
        return get(id);
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const fresh = new CellOrchestrator(deps);
      cleanup.push(() => fresh.dispose());
      const result = await fresh.reconcile().then(
        () => "resolved",
        (error: unknown) => error,
      );
      if (childFails) expect(result).toBeInstanceOf(CellControlConflict);
      else expect(result).toBe("resolved");
      expect(logged).toHaveBeenCalled();
      expect(calls.get(ids[0] as string)).toBe(2);
      expect(calls.get(ids[1] as string)).toBe(2);
      await waitFor(() => fresh.get(ids[1] as string)?.state === "ready");
      expect(fresh.browserAvailable(ids[1] as string)).toBe(!childFails);
    },
  );
});
