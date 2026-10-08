import { createHash, randomUUID } from "node:crypto";
import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { BrowserGeometry } from "../../../../cells/browser/browserd/src/geometry.ts";
import type { BrowserNative } from "../../../../cells/browser/browserd/src/native.ts";
import type { BrowserDocument } from "../../../../cells/browser/browserd/src/targets.ts";
import type { BrowserControlRequest } from "../../../../packages/protocol/src/browser-control.ts";
import type { ReadyBrowser } from "../cells/browser-orchestrator.ts";
import { BrowserClientError, type BrowserScope } from "./client.ts";
import {
  ScreenController,
  type ScreenControllerDeps,
  type ScreenScope,
} from "./screen-controller.ts";

function fixture() {
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
      stop: vi.fn(async () => {}),
    },
    client: () => client,
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

function measuredTabs(ids: string[]) {
  let active = ids[0];
  const documents: BrowserDocument[] = ids.map((tabId) =>
    Object.freeze({ tabId, revision: 1, frame: false }),
  );
  const geometry = new BrowserGeometry(
    {
      tabs: () => ids.map((id) => ({ id, ready: true })),
      documents: (id) => documents.filter((d) => d.tabId === id),
      check: (document) => {
        if (!documents.includes(document)) throw new Error("foreign document");
      },
      command: async (document, method) => {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { url: `https://example.test/${document.tabId}` } } };
        if (method === "Page.getLayoutMetrics")
          return {
            cssLayoutViewport: { pageX: 0, pageY: 0 },
            cssVisualViewport: {
              offsetX: 0,
              offsetY: 0,
              pageX: 0,
              pageY: 0,
              clientWidth: 1280,
              clientHeight: 713,
              scale: 1,
              zoom: 1,
            },
          };
        throw new Error("Unexpected read");
      },
      window: async () => ({ left: 0, top: 0, width: 1280, height: 800, windowState: "maximized" }),
    },
    {
      command: (async (method: string) => {
        if (method === "windows")
          return { windows: [{ id: 8, active: true, frame: [0, 0, 2560, 1600] }] };
        if (method === "surface")
          return {
            window: 8,
            page: {
              frame: [0, 174, 2560, 1426],
              windowFrame: [0, 0, 2560, 1600],
              focus: "page",
              urlHash: createHash("sha256").update(`https://example.test/${active}`).digest("hex"),
            },
          };
        throw new Error("Unexpected native read");
      }) as BrowserNative["command"],
    },
    2,
  );
  return {
    geometry,
    activate: (id: string) => {
      active = id;
    },
  };
}

describe("review: combined physical screen ownership", () => {
  it("positive: a sole foreground tab resolves through the actual geometry guard", async () => {
    const f = fixture();
    const measured = measuredTabs([f.tabId]);
    f.client.clock.mockImplementation(async (_permit, tabId, scope) => {
      scope.check();
      try {
        await measured.geometry.read(tabId, scope.signal);
      } catch {
        throw new BrowserClientError("unavailable");
      }
      scope.check();
      return { mono: 50 };
    });
    await f.controller.switchTo("browser", f.scope);
    const lease = f.controller.lease(f.scope);
    const access = f.controller.browserAccess(lease);
    await expect(measured.geometry.read(access.tabId, lease.signal)).resolves.toMatchObject({
      document: { tabId: f.tabId },
    });
    lease.finish();
    await f.controller.close();
  });
  it("handback selects the foreground page after the user opens a second ready tab", async () => {
    const f = fixture();
    const second = randomUUID();
    const measured = measuredTabs([f.tabId, second]);
    f.client.clock.mockImplementation(async (_permit, tabId, scope) => {
      scope.check();
      try {
        await measured.geometry.read(tabId, scope.signal);
      } catch {
        throw new BrowserClientError("unavailable");
      }
      scope.check();
      return { mono: 50 };
    });
    await f.controller.switchTo("browser", f.scope);
    await f.controller.takeOver();
    f.client.tabs.mockResolvedValue({
      tabs: [
        { id: f.tabId, ready: true },
        { id: second, ready: true },
      ],
    });
    measured.activate(second);
    await expect(measured.geometry.read(second, f.scope.signal)).resolves.toMatchObject({
      document: { tabId: second },
    });
    await f.controller.handback(f.scope);
    const lease = f.controller.lease(f.scope);
    try {
      const access = f.controller.browserAccess(lease);
      await expect(measured.geometry.read(access.tabId, lease.signal)).resolves.toMatchObject({
        document: { tabId: second },
      });
    } finally {
      lease.finish();
      await f.controller.close();
    }
  });
  it("positive: takeover waits for the old physical lease before admitting user input", async () => {
    const f = fixture();
    await f.controller.switchTo("browser", f.scope);
    const old = f.controller.lease(f.scope);
    let complete = false;
    const takeover = f.controller.takeOver().then(() => {
      complete = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(old.signal.aborted).toBe(true);
    expect(complete).toBe(false);
    expect(() => f.controller.manualAccess(f.scope)).toThrow();
    old.finish();
    await takeover;
    const manual = f.controller.manualAccess(f.scope);
    await expect(manual.input({ kind: "text", text: "S" })).resolves.toMatchObject({
      kind: "text",
    });
    expect(f.client.manual).toHaveBeenCalledTimes(1);
    manual.finish();
    await f.controller.close();
  });
  it("positive: endpoint replacement never reuses a held manual permit", async () => {
    const f = fixture();
    await f.controller.switchTo("browser", f.scope);
    await f.controller.takeOver();
    const manual = f.controller.manualAccess(f.scope);
    f.replace();
    expect(() => manual.input({ kind: "text", text: "S" })).toThrow();
    expect(f.client.manual).not.toHaveBeenCalled();
    manual.finish();
    await f.controller.close();
  });
});
