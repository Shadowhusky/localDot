import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BrowserGeometry } from "./geometry.ts";
import type { BrowserNative } from "./native.ts";
import { type BrowserDocument, BrowserTargetError } from "./targets.ts";

function setup(scale: 1 | 2 = 2) {
  const controller = new AbortController();
  const document = Object.freeze({ tabId: "tab", revision: 1, frame: false });
  const tabs = [{ id: "tab", ready: true }];
  const frame: [number, number, number, number] = [0, 87 * scale, 1280 * scale, 713 * scale];
  const windowFrame: [number, number, number, number] = [0, 0, 1280 * scale, 800 * scale];
  const page = {
    frame,
    windowFrame,
    urlHash: createHash("sha256").update("https://example.com/page").digest("hex"),
    focus: "page" as "page" | "chrome" | "unknown",
  };
  const metrics = {
    cssLayoutViewport: { pageX: 0, pageY: 12000 },
    cssVisualViewport: {
      offsetX: 0,
      offsetY: 0,
      pageX: 0,
      pageY: 12000,
      clientWidth: 1012,
      clientHeight: 570.4,
      scale: 1,
      zoom: 1.25,
    },
  };
  const check = vi.fn();
  const command = vi.fn(
    async (_document: BrowserDocument, method: string): Promise<Record<string, unknown>> => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { url: "https://example.com/page" } } };
      if (method === "Page.getLayoutMetrics") return metrics;
      throw new Error("unexpected command");
    },
  );
  const targets = {
    tabs: () => tabs,
    documents: (tabId: string) =>
      tabId === "tab" ? [document] : [{ tabId, revision: 1, frame: false }],
    check,
    command,
    window: vi.fn(async () => ({
      left: 0,
      top: 0,
      width: 1280,
      height: 800,
      windowState: "maximized" as const,
    })),
  };
  const nativeCommand = vi.fn(async (method: string): Promise<Record<string, unknown>> => {
    if (method === "windows") return { windows: [{ id: 8, active: true, frame: windowFrame }] };
    if (method === "surface") return { window: 8, page };
    throw new Error("unexpected native command");
  });
  const geometry = new BrowserGeometry(
    targets,
    { command: nativeCommand as unknown as BrowserNative["command"] },
    scale,
  );
  return { geometry, controller, document, targets, nativeCommand, page, metrics, tabs, check };
}

describe("browser measured geometry", () => {
  it.each(["horizontal", "vertical"])(
    "refuses document rounding before fractional %s scroll",
    async (axis) => {
      const peer = setup();
      const field = axis === "horizontal" ? "pageX" : "pageY";
      peer.metrics.cssLayoutViewport[field] = 0.25;
      peer.metrics.cssVisualViewport[field] = 0.25;
      const snapshot = await peer.geometry.read("tab", peer.controller.signal);
      const pointX = axis === "horizontal" ? 0.01 : 10;
      const pointY = axis === "vertical" ? 0.01 : 10;
      expect(() => peer.geometry.point(snapshot, pointX, pointY, peer.controller.signal)).toThrow(
        "point",
      );
      expect(() => peer.geometry.point(snapshot, 10, 10, peer.controller.signal)).not.toThrow();
    },
  );

  it("matches same-document fragment navigation using CDP's separate fragment field", async () => {
    const peer = setup();
    peer.page.urlHash = createHash("sha256")
      .update("https://example.com/page#anchor")
      .digest("hex");
    peer.targets.command.mockImplementation(async (_document, method) =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { url: "https://example.com/page", urlFragment: "#anchor" } } }
        : peer.metrics,
    );
    await expect(peer.geometry.read("tab", peer.controller.signal)).resolves.toMatchObject({
      scrollY: 12000,
    });
  });

  it.each([1, 2] as const)(
    "maps zoom and scroll at scale %s without stretching across the scrollbar",
    async (scale) => {
      const peer = setup(scale);
      const snapshot = await peer.geometry.read("tab", peer.controller.signal);
      const point = peer.geometry.point(snapshot, 170, 30, peer.controller.signal);
      expect(point.native).toEqual({ x: Math.round(212.5 * scale), y: Math.round(124.5 * scale) });
      expect(point.document).toEqual({ x: 170, y: 12030 });
      expect(point.screenshot).toEqual({ x: point.native.x / scale, y: point.native.y / scale });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.content)).toBe(true);
      expect(Object.isFrozen(point.native)).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain("example.com");
    },
  );

  it("preserves chrome focus and uses only read commands", async () => {
    const peer = setup();
    peer.page.focus = "chrome";
    expect((await peer.geometry.read("tab", peer.controller.signal)).focus).toBe("chrome");
    expect(peer.targets.command.mock.calls.map((call) => call[1])).toEqual([
      "Page.getFrameTree",
      "Page.getLayoutMetrics",
    ]);
    expect(peer.nativeCommand.mock.calls.map((call) => call[0])).toEqual([
      "windows",
      "surface",
      "surface",
    ]);
  });

  it.each(["offsetX", "offsetY", "scale"] as const)(
    "refuses unsupported viewport %s",
    async (field) => {
      const peer = setup();
      peer.metrics.cssVisualViewport[field] = 2;
      await expect(peer.geometry.read("tab", peer.controller.signal)).rejects.toThrow(
        "unavailable",
      );
    },
  );

  it.each([0, 6, Infinity, NaN])("refuses invalid zoom %s", async (zoom) => {
    const peer = setup();
    peer.metrics.cssVisualViewport.zoom = zoom;
    await expect(peer.geometry.read("tab", peer.controller.signal)).rejects.toThrow("unavailable");
  });

  it.each(["size", "offscreen", "window", "url", "duplicate"])(
    "refuses mismatched %s",
    async (reason) => {
      const peer = setup();
      if (reason === "size") peer.metrics.cssVisualViewport.clientWidth = 900;
      if (reason === "offscreen") peer.page.frame[1] = -1;
      if (reason === "window") peer.page.windowFrame[0] = 10;
      if (reason === "url") peer.page.urlHash = "a".repeat(64);
      if (reason === "duplicate") peer.tabs.push({ id: "duplicate", ready: true });
      await expect(peer.geometry.read("tab", peer.controller.signal)).rejects.toThrow(
        "unavailable",
      );
    },
  );

  it.each(["surface", "tabs"])("refuses %s changes at the final native await", async (change) => {
    const peer = setup();
    peer.nativeCommand.mockImplementation(async (method) => {
      if (method === "windows")
        return { windows: [{ id: 8, active: true, frame: peer.page.windowFrame }] };
      const final = peer.nativeCommand.mock.calls.length > 2;
      if (final && change === "tabs") peer.tabs.push({ id: "new", ready: true });
      return {
        window: 8,
        page: { ...peer.page, focus: final && change === "surface" ? "chrome" : "page" },
      };
    });
    await expect(peer.geometry.read("tab", peer.controller.signal)).rejects.toThrow(
      change === "surface" ? "unavailable" : "stale",
    );
  });

  // A page that adds frames or rewrites its URL as it settles changes its document mid-read.
  it("measures again a page whose document changed under the read", async () => {
    const peer = setup();
    peer.check.mockImplementationOnce(() => {
      throw new BrowserTargetError("stale");
    });
    await expect(peer.geometry.read("tab", peer.controller.signal)).resolves.toMatchObject({
      focus: "page",
    });
    expect(peer.targets.window).toHaveBeenCalledTimes(1);
  });

  // A click that starts a round rewrites the page's address while the browser shows the old one.
  it("measures again a page whose address changed during the read", async () => {
    const peer = setup();
    let surfaces = 0;
    peer.nativeCommand.mockImplementation(async (method) => {
      if (method === "windows")
        return { windows: [{ id: 8, active: true, frame: peer.page.windowFrame }] };
      surfaces += 1;
      return {
        window: 8,
        page: surfaces <= 2 ? { ...peer.page, urlHash: "b".repeat(64) } : peer.page,
      };
    });
    await expect(peer.geometry.read("tab", peer.controller.signal)).resolves.toMatchObject({
      focus: "page",
    });
    expect(surfaces).toBe(4);
  });

  it("stops measuring a page that keeps changing", async () => {
    const peer = setup();
    peer.check.mockImplementation(() => {
      throw new BrowserTargetError("unready");
    });
    await expect(peer.geometry.read("tab", peer.controller.signal)).rejects.toThrow("unavailable");
    expect(peer.targets.command.mock.calls.length).toBeLessThan(10);
  });

  it("stops after cancellation during the first asynchronous response", async () => {
    const peer = setup();
    peer.targets.command.mockImplementation(async () => {
      peer.controller.abort();
      return {};
    });
    await expect(peer.geometry.read("tab", peer.controller.signal)).rejects.toThrow("aborted");
    expect(peer.nativeCommand).not.toHaveBeenCalled();
    expect(peer.targets.window).not.toHaveBeenCalled();
  });

  it("rejects unowned snapshots, stale documents and aborted point requests", async () => {
    const peer = setup();
    const snapshot = await peer.geometry.read("tab", peer.controller.signal);
    expect(() => peer.geometry.point({ ...snapshot }, 10, 10, peer.controller.signal)).toThrow(
      "stale",
    );
    peer.check.mockImplementation(() => {
      throw new Error("stale document");
    });
    expect(() => peer.geometry.point(snapshot, 10, 10, peer.controller.signal)).toThrow("stale");
    peer.controller.abort();
    expect(() => peer.geometry.point(snapshot, 10, 10, peer.controller.signal)).toThrow("aborted");
  });

  it.each([
    [-1, 10],
    [10, -1],
    [1012, 10],
    [10, 570.4],
    [NaN, 10],
    [10, Infinity],
    [1011.99, 10],
  ])("refuses out-of-viewport or rounded edge points (%s,%s)", async (pointX, pointY) => {
    const peer = setup();
    const snapshot = await peer.geometry.read("tab", peer.controller.signal);
    expect(() => peer.geometry.point(snapshot, pointX, pointY, peer.controller.signal)).toThrow(
      "point",
    );
  });
});
