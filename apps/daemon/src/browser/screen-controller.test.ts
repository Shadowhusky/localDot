import { randomUUID } from "node:crypto";
import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import type { BrowserControlRequest } from "../../../../packages/protocol/src/browser-control.ts";
import type { BrowserDownloadBinding } from "../../../../packages/protocol/src/browser-downloads.ts";
import type { BrowserOrchestrator, ReadyBrowser } from "../cells/browser-orchestrator.ts";
import { BrowserClientError, type BrowserScope } from "./client.ts";
import {
  ScreenControlError,
  ScreenController,
  type ScreenControllerDeps,
  type ScreenScope,
  ScreenUnavailableError,
} from "./screen-controller.ts";

async function until(check: () => boolean) {
  for (let tries = 0; tries < 100 && !check(); tries++)
    await new Promise((resolve) => setImmediate(resolve));
  expect(check()).toBe(true);
}
function downloadingFixture(pendingFirstArm = false) {
  const records: {
    binding: BrowserDownloadBinding;
    scope: BrowserScope;
    stopped: boolean;
    blockDrain: boolean;
    finish(): void;
  }[] = [];
  const f = fixture((_endpoint, binding, scope) => {
    scope.check();
    const ready = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    void ready.promise.catch(() => {});
    const record = {
      binding,
      scope,
      stopped: false,
      blockDrain: false,
      finish() {
        ready.resolve();
        if (record.stopped) drained.resolve();
      },
    };
    records.push(record);
    if (!(pendingFirstArm && records.length === 1)) ready.resolve();
    return {
      ready: ready.promise,
      settled: drained.promise,
      stop() {
        record.stopped = true;
        if (!record.blockDrain) {
          ready.reject(new Error("collection cancelled"));
          drained.resolve();
        }
      },
    };
  });
  return {
    ...f,
    records,
    async close() {
      for (const record of records) {
        record.blockDrain = false;
        record.finish();
      }
      await f.controller.close();
    },
  };
}

describe("screen-owned download lifecycle", () => {
  it("arms only the browser with an exact session grant and outlives the switching request", async () => {
    const f = downloadingFixture();
    try {
      await f.controller.activate(f.scope);
      expect(f.records).toHaveLength(0);
      await f.controller.switchTo("browser", f.scope);
      const record = f.records[0];
      expect(record?.binding).toMatchObject({
        holder: "agent",
        sessionId: f.scope.sessionId,
        permit: {
          browserCellId: f.endpoint.browserCellId,
          parentCellId: f.endpoint.parentCellId,
          instance: f.endpoint.instance,
          owner: { sessionId: f.scope.sessionId, generation: 1 },
        },
      });
      f.abort.abort();
      expect(() => record?.scope.check()).not.toThrow();
    } finally {
      await f.close();
    }
  });

  it("fences collection immediately and drains before switching back to desktop", async () => {
    const f = downloadingFixture();
    try {
      await f.controller.switchTo("browser", f.scope);
      const record = f.records[0];
      if (!record) throw new Error("missing download owner");
      record.blockDrain = true;
      const controls = f.client.control.mock.calls.length;
      let completed = false;
      const switching = f.controller.switchTo("desktop", f.scope).then(() => {
        completed = true;
      });
      expect(record.stopped).toBe(true);
      expect(() => record.scope.check()).toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      expect(f.client.control).toHaveBeenCalledTimes(controls);
      record.finish();
      await switching;
      expect(f.controller.selection.screen).toBe("desktop");
      expect(f.records).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("binds manual downloads to this session and retires them before handback", async () => {
    const f = downloadingFixture();
    try {
      await f.controller.switchTo("browser", f.scope);
      const agent = f.records[0];
      await f.controller.takeOver();
      expect(agent?.stopped).toBe(true);
      expect(() => agent?.scope.check()).toThrow();
      const manual = f.records.at(-1);
      expect(manual?.binding).toMatchObject({ holder: "user", sessionId: f.scope.sessionId });
      expect(() => manual?.scope.check()).not.toThrow();
      await f.controller.handback(f.scope);
      expect(manual?.stopped).toBe(true);
      expect(() => manual?.scope.check()).toThrow();
      expect(f.records.at(-1)?.binding.holder).toBe("agent");
    } finally {
      await f.close();
    }
  });

  it("contains the cells while Stop waits for a collecting source to physically drain", async () => {
    const f = downloadingFixture();
    try {
      await f.controller.switchTo("browser", f.scope);
      const record = f.records[0];
      if (!record) throw new Error("missing download owner");
      record.blockDrain = true;
      let closed = false;
      const stop = f.controller.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.deps.contain).toHaveBeenCalledOnce();
      expect(record.stopped).toBe(true);
      expect(closed).toBe(false);
      record.finish();
      await stop;
    } finally {
      await f.close();
    }
  });

  it("cannot publish browser selection when download arming fails", async () => {
    const f = fixture(() => ({
      ready: Promise.reject(new Error("arming failed")),
      settled: Promise.resolve(),
      stop() {},
    }));
    try {
      await expect(f.controller.switchTo("browser", f.scope)).rejects.toThrow(
        ScreenUnavailableError,
      );
      expect(f.deps.publish).not.toHaveBeenCalled();
      expect(f.holder()).toBe("user");
      expect(f.deps.contain).not.toHaveBeenCalled();
      expect(f.controller.selection.screen).toBe("desktop");
    } finally {
      await f.controller.close();
    }
  });

  it("contains failed completion immediately while retaining a still-draining download owner", async () => {
    const f = downloadingFixture();
    await f.controller.switchTo("browser", f.scope);
    await f.controller.takeOver();
    const record = f.records.at(-1)!;
    expect(record.binding.holder).toBe("user");
    record.blockDrain = true;
    f.deps.fenceRecording.mockRejectedValueOnce(new Error("synthetic recording failure"));
    let settled = false;
    const closed = f.controller.finish().catch((error: unknown) => {
      settled = true;
      return error;
    });
    try {
      await until(() => f.deps.contain.mock.calls.length === 1);
      expect(record.stopped).toBe(true);
      expect(settled).toBe(false);
      expect(f.deps.browser.stop).not.toHaveBeenCalled();
      record.finish();
      expect(await closed).toBeInstanceOf(Error);
    } finally {
      record.finish();
      await f.close().catch(() => {});
    }
  });

  it("does not publish a late agent grant after takeover cancels pending arming", async () => {
    const f = downloadingFixture(true);
    try {
      const switching = f.controller.switchTo("browser", f.scope);
      const failed = expect(switching).rejects.toThrow();
      await until(() => f.records.length > 0);
      const takeover = f.controller.takeOver();
      await failed;
      await takeover;
      expect(f.records[0]?.stopped).toBe(true);
      expect(f.deps.publish).not.toHaveBeenCalled();
      expect(f.controller.selection.screen).toBe("desktop");
    } finally {
      await f.close();
    }
  });

  it("rejects the old collector immediately after a browser instance replacement", async () => {
    const f = downloadingFixture();
    try {
      await f.controller.switchTo("browser", f.scope);
      const record = f.records[0];
      f.replace();
      expect(() => record?.scope.check()).toThrow();
    } finally {
      await f.close();
    }
  });
});
function fixture(downloads?: ScreenControllerDeps["downloads"]) {
  const sessionId = ulid(),
    parentCellId = ulid(),
    tabId = randomUUID();
  const endpoint: ReadyBrowser = {
    parentCellId,
    browserCellId: ulid(),
    instance: randomUUID(),
    browserd: { baseUrl: "http://127.0.0.1:5000", token: "t".repeat(43) },
    stream: { baseUrl: "http://127.0.0.1:5001", authorization: "fixture" },
  };
  let current = endpoint;
  let revision = 0;
  let holder: "user" | "agent" = "user";
  const controlBarrier = vi.fn(async (_request: BrowserControlRequest) => {});
  const client = {
    manual: vi.fn(async (_permit: unknown, _input: unknown, scope: BrowserScope) => {
      scope.check();
      return {
        kind: "text" as const,
        receipt: {
          done: true as const,
          count: 1,
          firstPressMono: 2,
          armedMono: 1,
          injector: "xtest" as const,
        },
      };
    }),
    read: vi.fn(async () => {
      throw new Error("unused");
    }),
    clock: vi.fn(async (_permit: unknown, _tabId: string, scope: BrowserScope) => {
      scope.check();
      return { mono: 50 };
    }),
    settle: vi.fn(async () => {
      throw new Error("unused");
    }),
    lookup: vi.fn(async () => {
      throw new Error("unused");
    }),
    health: vi.fn(async (scope: BrowserScope) => {
      scope.check();
      return {
        parentCellId,
        browserCellId: current.browserCellId,
        instance: current.instance,
        ready: true as const,
        width: 1280 as const,
        height: 800 as const,
        holder,
      };
    }),
    tabs: vi.fn(async (scope: BrowserScope) => {
      scope.check();
      return { tabs: [{ id: tabId, ready: true }] };
    }),
    control: vi.fn(async (request: BrowserControlRequest, scope: BrowserScope) => {
      scope.check();
      if (request.revision <= revision) throw new Error("stale");
      revision = request.revision;
      if (request.holder === "user") holder = "user";
      await controlBarrier(request);
      scope.check();
      if (request.revision !== revision) throw new Error("superseded");
      holder = request.holder;
      const { owner: _owner, ...receipt } = { owner: undefined, ...request };
      return { ...receipt, reloaded: 0, selectionsCleared: true };
    }),
    close: vi.fn(),
    observe: vi.fn(async () => {
      throw new Error("unused");
    }),
    navigate: vi.fn(async () => {
      throw new Error("unused");
    }),
    input: vi.fn(async () => {
      throw new Error("unused");
    }),
    type: vi.fn(async () => {
      throw new Error("unused");
    }),
  };
  const deps = {
    sessionId,
    parentCellId,
    desktopGeometry: { w: 2560, h: 1600, scale: 2 as const },
    desktopReady: vi.fn(() => true),
    browser: {
      start: vi.fn(async () => current),
      endpoints: vi.fn(() => current),
      get: vi.fn<BrowserOrchestrator["get"]>(() => undefined),
      stop: vi.fn(async () => {}),
    },
    client: () => client,
    downloads,
    attachRecording: vi.fn<ScreenControllerDeps["attachRecording"]>(async () => {}),
    fenceRecording: vi.fn(async () => {}),
    publish: vi.fn<ScreenControllerDeps["publish"]>(),
    fenceSession: vi.fn(),
    contain: vi.fn(async () => {}),
  } satisfies ScreenControllerDeps;
  const controller = new ScreenController(deps);
  const abort = new AbortController();
  const scope: ScreenScope = { sessionId, generation: 1, signal: abort.signal, check: vi.fn() };
  return {
    controller,
    deps,
    scope,
    abort,
    endpoint,
    client,
    controlBarrier,
    tabId,
    holder: () => holder,
    replace: () => {
      current = { ...current, instance: randomUUID() };
    },
  };
}

describe("session screen coordinator", () => {
  it("hands the running browser to the next task with a newer control revision", async () => {
    const f = fixture();
    let counted = 0;
    const revision = vi.fn(() => ++counted);
    const first = new ScreenController({ ...f.deps, revision });
    await first.switchTo("browser", f.scope);
    await first.takeOver();
    await first.finish();
    expect(f.deps.browser.stop).not.toHaveBeenCalled();
    expect(f.holder()).toBe("user");
    const sessionId = ulid();
    const next = new ScreenController({ ...f.deps, sessionId, revision });
    await next.switchTo("browser", { ...f.scope, sessionId });
    expect(f.holder()).toBe("agent");
    const sent = f.client.control.mock.calls.map(([request]) => request.revision);
    expect(sent).toEqual([...sent].sort((a, b) => a - b));
    expect(new Set(sent).size).toBe(sent.length);
    expect(revision).toHaveBeenCalledWith(f.endpoint.instance);
    await next.close();
    expect(f.deps.browser.stop).toHaveBeenCalledOnce();
  });

  it("selects the unique native foreground instead of registry order", async () => {
    const f = fixture();
    const second = randomUUID();
    f.client.tabs.mockResolvedValue({
      tabs: [
        { id: f.tabId, ready: true },
        { id: second, ready: true },
      ],
    });
    f.client.clock.mockImplementation(async (_permit, tabId, scope) => {
      scope.check();
      if (tabId !== second) throw new BrowserClientError("unavailable");
      return { mono: 50 };
    });
    await f.controller.switchTo("browser", f.scope);
    const lease = f.controller.lease(f.scope);
    expect(f.controller.browserAccess(lease).tabId).toBe(second);
    expect(f.client.clock.mock.calls.map(([, tabId]) => tabId)).toEqual([f.tabId, second, second]);
    lease.finish();
    await f.controller.close();
  });

  it("says the web browser is starting only while it is", async () => {
    const f = fixture();
    vi.mocked(f.deps.browser.start).mockRejectedValue(new Error("synthetic start failure"));
    const refusal = () => f.controller.switchTo("browser", f.scope);
    await expect(refusal()).rejects.toThrow(/isn't available.*tell the user/u);
    vi.mocked(f.deps.browser.get).mockReturnValue({
      id: f.endpoint.browserCellId,
      parentCellId: f.endpoint.parentCellId,
      state: "starting",
    });
    await expect(refusal()).rejects.toThrow("still starting");
    await f.controller.close();
  });

  it("revokes the grant and fails only the call when no tab has unambiguous foreground geometry", async () => {
    const f = fixture();
    f.client.clock.mockRejectedValue(new BrowserClientError("unavailable"));
    await expect(f.controller.switchTo("browser", f.scope)).rejects.toThrow(ScreenUnavailableError);
    expect(f.deps.attachRecording).not.toHaveBeenCalled();
    expect(f.deps.publish).not.toHaveBeenCalled();
    expect(f.holder()).toBe("user");
    expect(f.deps.fenceSession).not.toHaveBeenCalled();
    expect(f.deps.contain).not.toHaveBeenCalled();
    await f.controller.close();
  });

  it("refuses a foreground change while recording is attached", async () => {
    const f = fixture();
    f.deps.attachRecording.mockImplementationOnce(async () => {
      f.client.clock.mockRejectedValue(new BrowserClientError("unavailable"));
    });
    await expect(f.controller.switchTo("browser", f.scope)).rejects.toThrow(ScreenUnavailableError);
    expect(f.deps.publish).not.toHaveBeenCalled();
    expect(f.holder()).toBe("user");
    expect(f.deps.contain).not.toHaveBeenCalled();
    const lease = f.controller.lease(f.scope);
    expect(lease.selection.screen).toBe("desktop");
    expect(() => f.controller.browserAccess(lease)).toThrow();
    lease.finish();
    await f.controller.close();
  });

  it("bounds foreground discovery even when a geometry probe is held", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.client.clock.mockImplementation(
        (_permit, _tabId, scope) =>
          new Promise((_resolve, reject) => {
            scope.signal.addEventListener(
              "abort",
              () => reject(new BrowserClientError("aborted")),
              { once: true },
            );
          }),
      );
      const pending = expect(f.controller.switchTo("browser", f.scope)).rejects.toThrow(
        ScreenUnavailableError,
      );
      await vi.advanceTimersByTimeAsync(6001);
      await pending;
      expect(f.client.clock).toHaveBeenCalledOnce();
      expect(f.deps.publish).not.toHaveBeenCalled();
      expect(f.holder()).toBe("user");
      expect(f.deps.contain).not.toHaveBeenCalled();
      await f.controller.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for takeover, binds user input to the browser, and drains before granting the agent", async () => {
    const f = fixture();
    await f.controller.switchTo("browser", f.scope);
    expect(() => f.controller.manualAccess(f.scope)).toThrow();
    const gate = Promise.withResolvers<void>();
    f.deps.fenceRecording.mockImplementationOnce(() => gate.promise);
    const taking = f.controller.takeOver();
    expect(() => f.controller.manualAccess(f.scope)).toThrow();
    gate.resolve();
    await taking;
    const manual = f.controller.manualAccess(f.scope);
    expect(manual.selection.geometry).toEqual({ w: 2560, h: 1600, scale: 2 });
    await manual.input({ kind: "text", text: "中" });
    expect(f.client.manual.mock.calls[0]?.[0]).not.toHaveProperty("owner");
    const grants = f.client.control.mock.calls.filter(
      ([request]) => request.holder === "agent",
    ).length;
    const returning = f.controller.handback(f.scope);
    expect(manual.signal.aborted).toBe(true);
    expect(() => manual.check()).toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      f.client.control.mock.calls.filter(([request]) => request.holder === "agent"),
    ).toHaveLength(grants);
    manual.finish();
    await returning;
    expect(f.holder()).toBe("agent");
    expect(() => f.controller.manualAccess(f.scope)).toThrow();
    await f.controller.close();
  });

  it("invalidates manual access when the browser or parent changes", async () => {
    const f = fixture();
    await f.controller.switchTo("browser", f.scope);
    await f.controller.takeOver();
    const manual = f.controller.manualAccess(f.scope);
    f.deps.desktopReady.mockReturnValue(false);
    expect(() => manual.check()).toThrow();
    f.deps.desktopReady.mockReturnValue(true);
    f.replace();
    expect(() => manual.check()).toThrow();
    manual.finish();
    await f.controller.close();
  });
  it("starts on the desktop and never grants browser authority from a display snapshot", () => {
    const f = fixture();
    expect(f.controller.selection).toMatchObject({
      screen: "desktop",
      cellId: f.deps.parentCellId,
      geometry: { w: 2560, h: 1600, scale: 2 },
      revision: 0,
    });
    const lease = f.controller.lease(f.scope);
    lease.check();
    expect(() => f.controller.browserAccess(lease)).toThrow();
    lease.finish();
    expect(() => lease.check()).toThrow();
    expect(f.deps.browser.start).not.toHaveBeenCalled();
  });

  it("publishes a switch only after confirmed control and recording attachment", async () => {
    const f = fixture();
    const attached = Promise.withResolvers<void>();
    f.deps.attachRecording.mockImplementationOnce(() => attached.promise);
    const switching = f.controller.switchTo("browser", f.scope);
    await until(() => f.deps.attachRecording.mock.calls.length === 1);
    expect(f.holder()).toBe("agent");
    expect(f.deps.publish).not.toHaveBeenCalled();
    expect(() => f.controller.lease(f.scope)).toThrow();
    attached.resolve();
    const switched = await switching;
    expect(switched).toMatchObject({
      screen: "browser",
      cellId: f.endpoint.browserCellId,
      geometry: { w: 2560, h: 1600, scale: 2 },
      revision: 1,
      by: "agent",
    });
    const lease = f.controller.lease(f.scope);
    expect(f.controller.browserAccess(lease)).toMatchObject({
      tabId: f.tabId,
      permit: { owner: { sessionId: f.scope.sessionId, generation: 1 } },
    });
    lease.finish();
  });

  it("invalidates old action leases synchronously and drains them before switching", async () => {
    const f = fixture();
    const prior = f.controller.lease(f.scope);
    const switching = f.controller.switchTo("browser", f.scope);
    expect(prior.signal.aborted).toBe(true);
    expect(() => prior.check()).toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.deps.browser.start).not.toHaveBeenCalled();
    prior.finish();
    await switching;
  });

  it("a delayed browser creation cannot grant authority after takeover", async () => {
    const f = fixture();
    const opened = Promise.withResolvers<ReadyBrowser>();
    f.deps.browser.start.mockImplementationOnce(() => opened.promise);
    const switching = f.controller.switchTo("browser", f.scope).catch((error: unknown) => error);
    await until(() => f.deps.browser.start.mock.calls.length === 1);
    const held = f.controller.takeOver();
    opened.resolve(f.endpoint);
    expect(await switching).toBeInstanceOf(Error);
    await held;
    expect(f.client.control.mock.calls.every(([request]) => request.holder === "user")).toBe(true);
    expect(f.deps.publish).not.toHaveBeenCalled();
    expect(f.deps.fenceSession).not.toHaveBeenCalled();
    expect(() => f.controller.lease(f.scope)).toThrow();
  });

  it("takeover supersedes a delayed agent grant and leaves no success event", async () => {
    const f = fixture();
    const grant = Promise.withResolvers<void>();
    f.controlBarrier.mockImplementation((request) =>
      request.holder === "agent" ? grant.promise : Promise.resolve(),
    );
    const switching = f.controller.switchTo("browser", f.scope).catch((error: unknown) => error);
    await until(() => f.client.control.mock.calls.some(([request]) => request.holder === "agent"));
    const held = f.controller.takeOver();
    grant.resolve();
    expect(await switching).toBeInstanceOf(Error);
    await held;
    expect(f.holder()).toBe("user");
    expect(f.deps.publish).not.toHaveBeenCalled();
    expect(f.deps.fenceSession).not.toHaveBeenCalled();
  });

  it("handback explicitly grants the selected screen to the current generation", async () => {
    const f = fixture();
    await f.controller.switchTo("browser", f.scope);
    await f.controller.takeOver();
    expect(f.holder()).toBe("user");
    const next = { ...f.scope, generation: 2 };
    const result = await f.controller.handback(next);
    expect(result).toMatchObject({ screen: "browser", revision: 2, by: "daemon" });
    expect(() => f.controller.lease(f.scope)).toThrow();
    const lease = f.controller.lease(next);
    expect(f.controller.browserAccess(lease).permit.owner.generation).toBe(2);
    lease.finish();
  });

  it("a renewed takeover cancels an in-flight handback", async () => {
    const f = fixture();
    await f.controller.switchTo("browser", f.scope);
    await f.controller.takeOver();
    const grant = Promise.withResolvers<void>();
    f.controlBarrier.mockImplementation((request) =>
      request.holder === "agent" ? grant.promise : Promise.resolve(),
    );
    const returning = f.controller.handback(f.scope).catch((error: unknown) => error);
    await until(
      () =>
        f.client.control.mock.calls.filter(([request]) => request.holder === "agent").length === 2,
    );
    const held = f.controller.takeOver();
    grant.resolve();
    expect(await returning).toBeInstanceOf(Error);
    await held;
    expect(f.holder()).toBe("user");
    expect(() => f.controller.lease(f.scope)).toThrow();
    expect(f.deps.publish).toHaveBeenCalledTimes(1);
  });

  it("failed recording attachment stops the session and contains both cells", async () => {
    const f = fixture();
    f.deps.attachRecording.mockRejectedValueOnce(new Error("disk failure"));
    await expect(f.controller.switchTo("browser", f.scope)).rejects.toThrow();
    expect(f.deps.publish).not.toHaveBeenCalled();
    expect(f.deps.fenceSession).toHaveBeenCalledTimes(1);
    expect(f.deps.contain).toHaveBeenCalledTimes(1);
    expect(() => f.controller.lease(f.scope)).toThrow();
  });

  it("fails only the call when the browser cannot start, before requesting any agent grant", async () => {
    const f = fixture();
    f.deps.browser.start.mockRejectedValueOnce(new Error("browser cell stopped"));
    await expect(f.controller.switchTo("browser", f.scope)).rejects.toThrow(ScreenUnavailableError);
    expect(f.client.control).not.toHaveBeenCalled();
    expect(f.deps.browser.stop).not.toHaveBeenCalled();
    expect(f.deps.fenceSession).not.toHaveBeenCalled();
    expect(f.deps.contain).not.toHaveBeenCalled();
    const lease = f.controller.lease(f.scope);
    expect(lease.selection.screen).toBe("desktop");
    lease.finish();
    expect((await f.controller.switchTo("browser", f.scope)).screen).toBe("browser");
  });

  it("fails only the call when the desktop is not ready", async () => {
    const f = fixture();
    await f.controller.switchTo("browser", f.scope);
    f.deps.desktopReady.mockReturnValue(false);
    await expect(f.controller.switchTo("desktop", f.scope)).rejects.toThrow(ScreenUnavailableError);
    expect(f.holder()).toBe("user");
    expect(f.deps.contain).not.toHaveBeenCalled();
    f.deps.desktopReady.mockReturnValue(true);
    expect((await f.controller.switchTo("desktop", f.scope)).screen).toBe("desktop");
  });

  it("physically retires a browser whose grant cannot be revoked before publishing the desktop", async () => {
    const f = fixture();
    await f.controller.switchTo("browser", f.scope);
    f.client.control.mockRejectedValueOnce(new BrowserClientError("unavailable"));
    const retired = Promise.withResolvers<void>();
    f.deps.browser.stop.mockImplementationOnce(() => retired.promise);
    const switching = f.controller.switchTo("desktop", f.scope);
    await until(() => f.deps.browser.stop.mock.calls.length === 1);
    expect(f.deps.attachRecording).toHaveBeenCalledTimes(1);
    expect(f.deps.publish).toHaveBeenCalledTimes(1);
    retired.resolve();
    expect((await switching).screen).toBe("desktop");
    expect(f.deps.browser.stop).toHaveBeenCalledWith(f.deps.parentCellId);
    expect(f.client.close).toHaveBeenCalled();
    expect(f.deps.fenceSession).not.toHaveBeenCalled();
    expect(f.deps.contain).not.toHaveBeenCalled();
  });

  it("physically retires a browser whose new grant cannot be revoked after a failed switch", async () => {
    const f = fixture();
    f.client.clock.mockRejectedValue(new BrowserClientError("unavailable"));
    f.controlBarrier.mockImplementation(async (request) => {
      if (request.holder === "user") throw new BrowserClientError("unavailable");
    });
    await expect(f.controller.switchTo("browser", f.scope)).rejects.toThrow(ScreenUnavailableError);
    expect(f.deps.browser.stop).toHaveBeenCalledWith(f.deps.parentCellId);
    expect(f.deps.publish).not.toHaveBeenCalled();
    expect(f.deps.contain).not.toHaveBeenCalled();
  });

  it.each(["previous", "requested"] as const)(
    "contains the session when a %s browser grant can be neither revoked nor physically retired",
    async (grant) => {
      const f = fixture();
      if (grant === "previous") await f.controller.switchTo("browser", f.scope);
      else f.client.clock.mockRejectedValue(new BrowserClientError("unavailable"));
      f.controlBarrier.mockImplementation(async (request) => {
        if (request.holder === "user") throw new BrowserClientError("unavailable");
      });
      f.deps.browser.stop.mockRejectedValueOnce(new Error("shutdown unconfirmed"));
      await expect(
        f.controller.switchTo(grant === "previous" ? "desktop" : "browser", f.scope),
      ).rejects.toThrow(ScreenControlError);
      expect(f.deps.fenceSession).toHaveBeenCalledOnce();
      expect(f.deps.contain).toHaveBeenCalledOnce();
      expect(() => f.controller.lease(f.scope)).toThrow();
    },
  );

  it("failed handback also contains uncertainty instead of silently leaving a grant", async () => {
    const f = fixture();
    await f.controller.switchTo("browser", f.scope);
    await f.controller.takeOver();
    f.deps.attachRecording.mockRejectedValueOnce(new Error("reattach failed"));
    await expect(f.controller.handback(f.scope)).rejects.toThrow();
    expect(f.deps.contain).toHaveBeenCalledTimes(1);
    expect(f.deps.publish).toHaveBeenCalledTimes(1);
  });

  it("refuses a replaced browser and a forged action lease", async () => {
    const f = fixture();
    await f.controller.switchTo("browser", f.scope);
    const lease = f.controller.lease(f.scope);
    expect(() => f.controller.browserAccess({ ...lease, check: () => {} })).toThrow();
    f.replace();
    expect(() => lease.check()).toThrow();
    lease.finish();
  });

  it("terminal close contains immediately but waits for a late preparation and final retirement", async () => {
    const f = fixture();
    const opened = Promise.withResolvers<ReadyBrowser>();
    f.deps.browser.start.mockImplementationOnce(() => opened.promise);
    const switching = f.controller.switchTo("browser", f.scope).catch((error: unknown) => error);
    await until(() => f.deps.browser.start.mock.calls.length === 1);
    let settled = false;
    const closed = f.controller.close().then(() => {
      settled = true;
    });
    expect(f.deps.contain).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    opened.resolve(f.endpoint);
    expect(await switching).toBeInstanceOf(Error);
    await closed;
    expect(f.deps.browser.stop).toHaveBeenCalledWith(f.deps.parentCellId);
    expect(f.client.close).toHaveBeenCalled();
    await expect(f.controller.switchTo("desktop", f.scope)).rejects.toThrow();
  });

  it("rejects another session before creating a browser", async () => {
    const f = fixture();
    await expect(
      f.controller.switchTo("browser", { ...f.scope, sessionId: ulid() }),
    ).rejects.toThrow();
    expect(f.deps.browser.start).not.toHaveBeenCalled();
  });

  it("terminal containment remains single-owner when session stop reenters close", async () => {
    const f = fixture();
    const closes: Promise<void>[] = [];
    f.deps.fenceSession.mockImplementation(() => {
      closes.push(f.controller.close());
    });
    const closed = f.controller.close();
    expect(closes).toEqual([closed]);
    await closed;
    expect(f.deps.contain).toHaveBeenCalledTimes(1);
    expect(f.deps.fenceRecording).toHaveBeenCalledTimes(1);
  });

  it("failed handback cannot reuse an earlier successful takeover receipt", async () => {
    const f = fixture();
    await f.controller.switchTo("browser", f.scope);
    await f.controller.takeOver();
    f.deps.attachRecording.mockRejectedValueOnce(new Error("failed handback"));
    await expect(f.controller.handback(f.scope)).rejects.toThrow();
    await expect(f.controller.takeOver()).rejects.toThrow();
  });

  it("failed publication can stop its owning session without deadlocking reentrant close", async () => {
    const f = fixture();
    let closed: Promise<void> | undefined;
    f.deps.fenceSession.mockImplementation(() => {
      closed = f.controller.close();
    });
    f.deps.publish.mockImplementationOnce(() => {
      throw new Error("journal failed");
    });
    await expect(f.controller.switchTo("browser", f.scope)).rejects.toThrow();
    await closed;
    expect(f.deps.contain).toHaveBeenCalledTimes(1);
    expect(f.deps.browser.stop).toHaveBeenCalledTimes(1);
  });

  it("serializes browser then desktop switches and retains their own geometries", async () => {
    const f = fixture();
    const first = f.controller.switchTo("browser", f.scope);
    const second = f.controller.switchTo("desktop", f.scope);
    expect((await first).geometry).toEqual({ w: 2560, h: 1600, scale: 2 });
    expect((await second).geometry.scale).toBe(2);
    expect(f.deps.publish.mock.calls.map(([event]) => [event.screen, event.revision])).toEqual([
      ["browser", 1],
      ["desktop", 2],
    ]);
    expect(f.holder()).toBe("user");
  });
});
