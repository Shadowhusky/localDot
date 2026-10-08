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

describe("scoped geometry correction boundary review", () => {
  it.each([1, 2] as const)("refuses rounded physical right edge at scale %s", async (scale) => {
    const peer = setup(scale);
    peer.page.frame.splice(0, 4, 84 * scale, 147 * scale, 889 * scale, 529 * scale);
    peer.metrics.cssVisualViewport.clientWidth = 711.20001;
    peer.metrics.cssVisualViewport.clientHeight = 423.20001220703125;
    const snapshot = await peer.geometry.read("tab", peer.controller.signal);
    expect(peer.geometry.point(snapshot, 710.5, 10, peer.controller.signal).native.x).toBeLessThan(
      973 * scale,
    );
    expect(() => peer.geometry.point(snapshot, 711.199, 10, peer.controller.signal)).toThrow(
      "point",
    );
  });

  it("refuses rounded document bottom even when its physical pixel is interior", async () => {
    const peer = setup(2);
    peer.metrics.cssVisualViewport.clientHeight = 570;
    const snapshot = await peer.geometry.read("tab", peer.controller.signal);
    const good = peer.geometry.point(snapshot, 10, 569.49, peer.controller.signal);
    expect(good.document.y).toBe(12569);
    expect(good.native.y).toBeLessThan(snapshot.content[1] + snapshot.height * snapshot.factor);
    expect(() => peer.geometry.point(snapshot, 10, 569.6, peer.controller.signal)).toThrow("point");
  });
});
