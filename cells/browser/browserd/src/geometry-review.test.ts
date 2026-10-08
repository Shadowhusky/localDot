import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BrowserGeometry } from "./geometry.ts";
import type { BrowserNative } from "./native.ts";
import type { BrowserDocument } from "./targets.ts";

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

describe("independent geometry boundary review", () => {
  it.each([1, 2] as const)(
    "I1 refuses rounding onto the physical content bottom at scale %s despite CDP float excess",
    async (scale) => {
      const peer = setup(scale);
      peer.page.frame.splice(0, 4, 84 * scale, 147 * scale, 892 * scale, 529 * scale);
      peer.page.windowFrame.splice(0, 4, 80 * scale, 60 * scale, 900 * scale, 620 * scale);
      peer.targets.window.mockResolvedValue({
        left: 80,
        top: 60,
        width: 900,
        height: 620,
        windowState: "maximized",
      });
      peer.metrics.cssVisualViewport.clientWidth = 701.6000366210938;
      peer.metrics.cssVisualViewport.clientHeight = 423.20001220703125;
      const snapshot = await peer.geometry.read("tab", peer.controller.signal);
      expect(
        peer.geometry.point(snapshot, 170, 422.5, peer.controller.signal).native.y,
      ).toBeLessThan(snapshot.content[1] + snapshot.content[3]);
      expect(() => peer.geometry.point(snapshot, 170, 423.199, peer.controller.signal)).toThrow(
        "point",
      );
    },
  );

  it("I1 refuses a rounded document hit-test point outside the viewport even when its physical pixel fits", async () => {
    const peer = setup(2);
    const snapshot = await peer.geometry.read("tab", peer.controller.signal);
    const positive = peer.geometry.point(snapshot, 1011.49, 30, peer.controller.signal);
    expect(positive.document.x).toBe(1011);
    expect(positive.native.x).toBeLessThan(snapshot.content[0] + snapshot.width * snapshot.factor);
    expect(() => peer.geometry.point(snapshot, 1011.6, 30, peer.controller.signal)).toThrow(
      "point",
    );
  });

  it("P1 permits ordinary subpixel interior points without rounding across any boundary", async () => {
    const peer = setup(1);
    const snapshot = await peer.geometry.read("tab", peer.controller.signal);
    const point = peer.geometry.point(snapshot, 170.1, 30.1, peer.controller.signal);
    expect(point.native).toEqual({ x: 213, y: 125 });
    expect(point.document).toEqual({ x: 170, y: 12030 });
  });

  it("P2 refuses a snapshot from another reader and stops before publication after final-surface cancellation", async () => {
    const peer = setup();
    const snapshot = await peer.geometry.read("tab", peer.controller.signal);
    const other = new BrowserGeometry(
      peer.targets,
      { command: peer.nativeCommand as unknown as BrowserNative["command"] },
      2,
    );
    expect(() => other.point(snapshot, 10, 10, peer.controller.signal)).toThrow("stale");
    peer.nativeCommand.mockClear();
    peer.nativeCommand.mockImplementation(async (method) => {
      if (method === "windows")
        return { windows: [{ id: 8, active: true, frame: peer.page.windowFrame }] };
      if (peer.nativeCommand.mock.calls.length === 3) peer.controller.abort();
      return { window: 8, page: peer.page };
    });
    await expect(peer.geometry.read("tab", peer.controller.signal)).rejects.toThrow("aborted");
  });

  it("P3 rejects document identity changed during native sampling and never leaks the private cause", async () => {
    const peer = setup();
    peer.nativeCommand.mockImplementation(async (method) => {
      if (method === "windows")
        return { windows: [{ id: 8, active: true, frame: peer.page.windowFrame }] };
      peer.check.mockImplementation(() => {
        throw new Error("private-document-canary");
      });
      return { window: 8, page: peer.page };
    });
    await expect(peer.geometry.read("tab", peer.controller.signal)).rejects.toThrow(
      "Browser geometry refused: unavailable",
    );
    expect(peer.targets.command.mock.calls.map((call) => call[1])).toEqual(["Page.getFrameTree"]);
  });
});
