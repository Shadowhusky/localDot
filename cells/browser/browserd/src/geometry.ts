import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z as schema } from "zod";
import type { BrowserNative } from "./native.ts";
import {
  type BrowserDocument,
  type BrowserTargets,
  PAGE_READ_ATTEMPTS,
  PAGE_READ_RETRY_MS,
  pageChanged,
} from "./targets.ts";

const documentCoordinate = schema.number().finite().min(0).max(0x7ffffffe);
const viewportDimension = schema.number().finite().positive().max(32768);
const metricsSchema = schema.object({
  cssLayoutViewport: schema.object({ pageX: documentCoordinate, pageY: documentCoordinate }),
  cssVisualViewport: schema.object({
    offsetX: schema.literal(0),
    offsetY: schema.literal(0),
    pageX: documentCoordinate,
    pageY: documentCoordinate,
    clientWidth: viewportDimension,
    clientHeight: viewportDimension,
    scale: schema.literal(1),
    zoom: schema.number().finite().min(0.25).max(5),
  }),
});
const frameSchema = schema.object({
  frameTree: schema.object({
    frame: schema.object({
      url: schema.string().min(1).max(32768),
      urlFragment: schema.string().max(32768).regex(/^#.*$/u).optional(),
    }),
  }),
});

type GeometryTargets = Pick<BrowserTargets, "tabs" | "documents" | "check" | "command" | "window">;
type Rect = readonly [number, number, number, number];

export class BrowserGeometryError extends Error {
  constructor(readonly reason: "aborted" | "stale" | "unavailable" | "point") {
    super(`Browser geometry refused: ${reason}`);
  }
}

export interface BrowserGeometrySnapshot {
  readonly document: BrowserDocument;
  readonly content: Rect;
  readonly width: number;
  readonly height: number;
  readonly factor: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly focus: "page" | "chrome" | "unknown";
}

export interface BrowserPoint {
  readonly native: Readonly<{ x: number; y: number }>;
  readonly screenshot: Readonly<{ x: number; y: number }>;
  readonly document: Readonly<{ x: number; y: number }>;
}

function hashUrl(raw: unknown): string {
  const parsed = frameSchema.safeParse(raw);
  if (!parsed.success) throw new BrowserGeometryError("unavailable");
  const { url, urlFragment } = parsed.data.frameTree.frame;
  if (url.length + (urlFragment?.length ?? 0) > 32768)
    throw new BrowserGeometryError("unavailable");
  return createHash("sha256")
    .update(url + (urlFragment ?? ""))
    .digest("hex");
}

function sameRect(first: Rect, second: Rect, tolerance = 0): boolean {
  return first.every((value, position) => Math.abs(value - (second[position] ?? NaN)) <= tolerance);
}

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner[2] > 0 &&
    inner[3] > 0 &&
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[0] + inner[2] <= outer[0] + outer[2] &&
    inner[1] + inner[3] <= outer[1] + outer[3]
  );
}

export class BrowserGeometry {
  readonly #snapshots = new WeakSet<BrowserGeometrySnapshot>();

  constructor(
    private readonly targets: GeometryTargets,
    private readonly native: Pick<BrowserNative, "command">,
    private readonly scale: 1 | 2,
  ) {
    if (scale !== 1 && scale !== 2) throw new BrowserGeometryError("unavailable");
  }

  #check(signal: AbortSignal, documents: readonly BrowserDocument[] = []): void {
    if (signal.aborted) throw new BrowserGeometryError("aborted");
    for (const document of documents) this.targets.check(document);
  }

  async read(tabId: string, signal: AbortSignal): Promise<BrowserGeometrySnapshot> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#measure(tabId, signal);
      } catch (error) {
        if (signal.aborted) throw new BrowserGeometryError("aborted");
        if (error instanceof BrowserGeometryError) throw error;
        if (!pageChanged(error) || attempt >= PAGE_READ_ATTEMPTS)
          throw new BrowserGeometryError("unavailable");
      }
      await sleep(PAGE_READ_RETRY_MS, undefined, { signal }).catch(() => {});
    }
  }

  async #measure(tabId: string, signal: AbortSignal): Promise<BrowserGeometrySnapshot> {
    this.#check(signal);
    const tabs = [...this.targets.tabs()];
    if (tabs.length > 256 || tabs.some((tab) => !tab.ready))
      throw new BrowserGeometryError("unavailable");
    const documents = tabs.map((tab) => {
      const roots = this.targets.documents(tab.id).filter((document) => !document.frame);
      if (roots.length !== 1 || !roots[0]) throw new BrowserGeometryError("unavailable");
      return roots[0];
    });
    const document = documents.find((entry) => entry.tabId === tabId);
    if (!document) throw new BrowserGeometryError("unavailable");
    const hashes = new Map<BrowserDocument, string>();
    for (const entry of documents) {
      const frame = await this.targets.command(entry, "Page.getFrameTree", {}, signal);
      this.#check(signal, documents);
      hashes.set(entry, hashUrl(frame));
    }
    const urlHash = hashes.get(document);
    if (!urlHash || [...hashes.values()].filter((value) => value === urlHash).length !== 1)
      throw new BrowserGeometryError("unavailable");
    const bounds = await this.targets.window(tabId, signal);
    this.#check(signal, documents);
    if (!["normal", "maximized"].includes(bounds.windowState))
      throw new BrowserGeometryError("unavailable");
    const { windows } = await this.native.command("windows", {}, signal);
    this.#check(signal, documents);
    const active = windows.filter((window) => window.active);
    const window = active[0];
    if (active.length !== 1 || !window) throw new BrowserGeometryError("unavailable");
    const expected: Rect = [
      bounds.left * this.scale,
      bounds.top * this.scale,
      bounds.width * this.scale,
      bounds.height * this.scale,
    ];
    if (!sameRect(expected, window.frame, this.scale))
      throw new BrowserGeometryError("unavailable");
    const first = await this.native.command("surface", { window: window.id }, signal);
    this.#check(signal, documents);
    const raw = await this.targets.command(document, "Page.getLayoutMetrics", {}, signal);
    this.#check(signal, documents);
    const metrics = metricsSchema.safeParse(raw);
    if (!metrics.success) throw new BrowserGeometryError("unavailable");
    const second = await this.native.command("surface", { window: window.id }, signal);
    this.#check(signal, documents);
    const page = second.page;
    if (
      !page ||
      !first.page ||
      first.window !== window.id ||
      second.window !== window.id ||
      page.urlHash !== urlHash ||
      first.page.urlHash !== urlHash ||
      page.focus !== first.page.focus ||
      !sameRect(first.page.frame, page.frame) ||
      !sameRect(first.page.windowFrame, page.windowFrame) ||
      !sameRect(page.windowFrame, window.frame)
    )
      throw new BrowserGeometryError("unavailable");
    const screen: Rect = [0, 0, 1280 * this.scale, 800 * this.scale];
    if (!inside(page.frame, page.windowFrame) || !inside(page.frame, screen))
      throw new BrowserGeometryError("unavailable");
    const viewport = metrics.data.cssVisualViewport;
    const layout = metrics.data.cssLayoutViewport;
    const factor = this.scale * viewport.zoom;
    if (
      viewport.pageX !== layout.pageX ||
      viewport.pageY !== layout.pageY ||
      viewport.clientWidth * factor > page.frame[2] + 0.01 ||
      viewport.clientHeight * factor > page.frame[3] + 0.01 ||
      page.frame[2] - viewport.clientWidth * factor > 40 * this.scale ||
      page.frame[3] - viewport.clientHeight * factor > 40 * this.scale
    )
      throw new BrowserGeometryError("unavailable");
    const current = this.targets.tabs();
    if (
      current.length !== tabs.length ||
      current.some((tab, position) => !tab.ready || tab.id !== tabs[position]?.id)
    )
      throw new BrowserGeometryError("stale");
    this.#check(signal, documents);
    const snapshot = Object.freeze({
      document,
      content: Object.freeze([...page.frame]) as Rect,
      width: viewport.clientWidth,
      height: viewport.clientHeight,
      factor,
      scrollX: layout.pageX,
      scrollY: layout.pageY,
      focus: page.focus,
    });
    this.#snapshots.add(snapshot);
    return snapshot;
  }

  point(
    snapshot: BrowserGeometrySnapshot,
    pointX: number,
    pointY: number,
    signal: AbortSignal,
  ): BrowserPoint {
    this.#check(signal);
    if (!this.#snapshots.has(snapshot)) throw new BrowserGeometryError("stale");
    this.#check(signal, [snapshot.document]);
    if (
      !Number.isFinite(pointX) ||
      !Number.isFinite(pointY) ||
      pointX < 0 ||
      pointY < 0 ||
      pointX >= snapshot.width ||
      pointY >= snapshot.height
    )
      throw new BrowserGeometryError("point");
    const physicalX = Math.round(snapshot.content[0] + pointX * snapshot.factor);
    const physicalY = Math.round(snapshot.content[1] + pointY * snapshot.factor);
    const documentX = Math.round(pointX + snapshot.scrollX);
    const documentY = Math.round(pointY + snapshot.scrollY);
    if (
      physicalX < snapshot.content[0] ||
      physicalY < snapshot.content[1] ||
      physicalX >= snapshot.content[0] + snapshot.content[2] ||
      physicalY >= snapshot.content[1] + snapshot.content[3] ||
      physicalX >=
        Math.min(snapshot.content[0] + snapshot.width * snapshot.factor, 1280 * this.scale) ||
      physicalY >=
        Math.min(snapshot.content[1] + snapshot.height * snapshot.factor, 800 * this.scale) ||
      documentX < snapshot.scrollX ||
      documentY < snapshot.scrollY ||
      documentX >= snapshot.scrollX + snapshot.width ||
      documentY >= snapshot.scrollY + snapshot.height ||
      documentX > 0x7fffffff ||
      documentY > 0x7fffffff
    )
      throw new BrowserGeometryError("point");
    return Object.freeze({
      native: Object.freeze({ x: physicalX, y: physicalY }),
      screenshot: Object.freeze({ x: physicalX / this.scale, y: physicalY / this.scale }),
      document: Object.freeze({ x: documentX, y: documentY }),
    });
  }
}
