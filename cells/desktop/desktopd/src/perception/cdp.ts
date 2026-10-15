import {
  checkedOf,
  clipText,
  type ElementState,
  type FindRequest,
  loginForm,
  type Point,
  type Rect,
  type Target,
  type WireElement,
} from "@localdot/protocol";
import { WebSocket } from "ws";
import type { HelperWindow } from "./hit-test.ts";

export interface PageTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface PageMetrics {
  dpr: number;
  chromeW: number;
  chromeH: number;
  innerWidth?: number;
  innerHeight?: number;
  url?: string;
}

// Chromium's content area in device pixels: the X client origin plus its own chrome (tab strip
// and toolbar) in CSS px × the device scale factor. With xfwm4's borderless maximize there is no
// WM frame; a restored window's title bar sits above the client origin and so is already excluded.
export function contentOrigin(win: HelperWindow, m: PageMetrics): Point {
  return {
    x: win.x + Math.round((m.chromeW / 2) * m.dpr),
    y: win.y + Math.round(m.chromeH * m.dpr),
  };
}

export function quadToRect(quad: number[], origin: Point, dpr: number): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return {
    x: origin.x + Math.round(x0 * dpr),
    y: origin.y + Math.round(y0 * dpr),
    w: Math.round((Math.max(...xs) - x0) * dpr),
    h: Math.round((Math.max(...ys) - y0) * dpr),
  };
}

// Multiple windows/tabs can share a title. Ambiguity must not select an unrelated page.
export function pickTarget(targets: PageTarget[], win: HelperWindow): PageTarget | undefined {
  const pages = targets.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
  const title = win.title.replace(/ - Chromium$/, "");
  const matches = pages.filter((t) => t.title === title);
  if (matches.length === 1) return matches[0];
  return matches.length === 0 && pages.length === 1 ? pages[0] : undefined;
}

// What a person can click, type into or choose on a page.
const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "listbox",
  "treeitem",
  "PopUpButton",
]);
// Roles whose value is what the field shows.
const VALUED = new Set(["textbox", "searchbox", "combobox", "slider", "spinbutton", "PopUpButton"]);
// Box models are read this many at a time, up to a page's first MAX_BOXED interactive elements.
const BOX_BATCH = 400;
const MAX_BOXED = 4000;

interface AxNode {
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
}

function stateOf(node: AxNode, secret: boolean): ElementState {
  const property = (name: string) => node.properties?.find((p) => p.name === name)?.value.value;
  const checked = checkedOf(property("checked"));
  const expanded = property("expanded");
  const value = node.value?.value;
  return {
    ...(VALUED.has(node.role?.value ?? "") && !secret && value !== undefined && value !== ""
      ? { value: clipText(String(value), 200) }
      : {}),
    ...(checked ? { checked } : {}),
    ...(property("disabled") === true ? { disabled: true as const } : {}),
    ...(typeof expanded === "boolean" ? { expanded } : {}),
  };
}

// The part of a box inside the page's viewport, or undefined when none of it is.
function visiblePart(box: Rect, origin: Point, m: PageMetrics): Rect | undefined {
  const right = origin.x + Math.round((m.innerWidth ?? 0) * m.dpr);
  const bottom = origin.y + Math.round((m.innerHeight ?? 0) * m.dpr);
  const x0 = Math.max(box.x, origin.x);
  const y0 = Math.max(box.y, origin.y);
  const x1 = Math.min(box.x + box.w, right);
  const y1 = Math.min(box.y + box.h, bottom);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}

const METRICS =
  "({dpr: window.devicePixelRatio, chromeW: window.outerWidth - window.innerWidth, chromeH: window.outerHeight - window.innerHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight, url: location.href})";

export class CdpSession {
  #ws: WebSocket;
  #seq = 0;
  #closed = false;
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  readonly ready: Promise<void>;

  constructor(url: string, WebSocketImpl: typeof WebSocket = WebSocket, timeoutMs = 1500) {
    this.#ws = new WebSocketImpl(url);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("cdp: connection timed out"));
        this.#ws.terminate();
      }, timeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.#ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.#ws.once("error", fail);
      this.#ws.once("close", () => fail(new Error("cdp: connection closed before ready")));
    });
    // ws emits "error" again on a later socket failure; without a listener Node would throw it.
    this.#ws.on("error", () => undefined);
    this.#ws.on("message", (data) => {
      let msg: {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      try {
        msg = JSON.parse(String(data));
      } catch {
        this.#ws.terminate();
        return;
      }
      if (msg.id === undefined) return;
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`cdp: ${msg.error.message}`));
      else p.resolve(msg.result);
    });
    this.#ws.on("close", () => {
      this.#closed = true;
      for (const p of this.#pending.values()) p.reject(new Error("cdp: connection closed"));
      this.#pending.clear();
    });
  }

  // A page that navigated away or crashed closes its socket; the session cannot be reused.
  get closed(): boolean {
    return this.#closed;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 3000,
  ): Promise<T> {
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("cdp: connection is not open"));
    const id = ++this.#seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`cdp: ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }), (error) => {
          if (error) {
            const pending = this.#pending.get(id);
            this.#pending.delete(id);
            pending?.reject(error);
          }
        });
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  close(): void {
    this.#ws.close();
  }
}

// Each perception operation has its own deadline, even when its socket is shared.
class CdpOperation {
  constructor(
    readonly session: CdpSession,
    readonly deadline: number,
  ) {}
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) return Promise.reject(new Error("cdp: perception deadline exceeded"));
    return this.session.send<T>(method, params, Math.min(3000, remaining));
  }
}

export class ChromiumPerception {
  readonly #port: number;
  readonly #fetchImpl: typeof fetch;
  readonly #WebSocketImpl: typeof WebSocket;
  readonly #originProvider?: (win: HelperWindow, dpr: number) => Promise<Point | undefined>;
  readonly #origins = new Map<number, { key: string; point: Point }>();
  #sessions = new Map<string, CdpSession>();

  constructor(
    opts: {
      port?: number;
      fetchImpl?: typeof fetch;
      WebSocketImpl?: typeof WebSocket;
      originProvider?: (win: HelperWindow, dpr: number) => Promise<Point | undefined>;
    } = {},
  ) {
    this.#port = opts.port ?? 9222;
    this.#fetchImpl = opts.fetchImpl ?? fetch;
    this.#WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
    this.#originProvider = opts.originProvider;
  }

  async #origin(win: HelperWindow, metrics: PageMetrics): Promise<Point> {
    const key = `${win.x},${win.y},${win.w},${win.h},${metrics.dpr},${metrics.chromeW},${metrics.chromeH}`;
    const saved = this.#origins.get(win.id);
    if (saved?.key === key) return saved.point;
    const native = await this.#originProvider?.(win, metrics.dpr);
    if (this.#originProvider && !native) throw new Error("browser content origin unavailable");
    const point = native ?? contentOrigin(win, metrics);
    this.#origins.set(win.id, { key, point });
    return point;
  }

  async #session(win: HelperWindow): Promise<{ cdp: CdpOperation; target: PageTarget }> {
    const deadline = performance.now() + 4000;
    const res = await this.#fetchImpl(`http://127.0.0.1:${this.#port}/json/list`, {
      signal: AbortSignal.timeout(1500),
    });
    const targets = (await res.json()) as PageTarget[];
    const ids = new Set(targets.map((t) => t.id));
    for (const [id, session] of this.#sessions) {
      if (!ids.has(id)) {
        session.close();
        this.#sessions.delete(id);
      }
    }
    const target = pickTarget(targets, win);
    if (!target) throw new Error("cdp: no page target");
    let cdp = this.#sessions.get(target.id);
    if (!cdp || cdp.closed) {
      cdp = new CdpSession(
        target.webSocketDebuggerUrl,
        this.#WebSocketImpl,
        Math.max(1, Math.min(1500, deadline - performance.now())),
      );
      await cdp.ready;
      // The Accessibility domain (getPartialAXTree, the experimental queryAXTree) answers only
      // after enable; once per session.
      await new CdpOperation(cdp, deadline).send("Accessibility.enable");
      this.#sessions.set(target.id, cdp);
    }
    return { cdp: new CdpOperation(cdp, deadline), target };
  }

  async #metrics(cdp: CdpOperation): Promise<PageMetrics> {
    const r = await cdp.send<{ result: { value: PageMetrics } }>("Runtime.evaluate", {
      expression: METRICS,
      returnByValue: true,
    });
    return r.result.value;
  }

  async deviceScaleFactor(win: HelperWindow): Promise<number> {
    const { cdp } = await this.#session(win);
    return (await this.#metrics(cdp)).dpr;
  }

  async #describe(
    cdp: CdpOperation,
    backendNodeId: number,
    win: HelperWindow,
    origin: Point,
    dpr: number,
    url: string | undefined,
    point?: Point,
    ax?: { role?: string; name?: string },
  ): Promise<Target | null> {
    const box = await cdp
      .send<{ model: { border: number[] } }>("DOM.getBoxModel", { backendNodeId })
      .catch(() => null);
    if (!box) return null;
    const bbox = quadToRect(box.model.border, origin, dpr);
    let role = ax?.role;
    let name = ax?.name;
    if (!ax) {
      const tree = await cdp
        .send<{ nodes: { role?: { value: string }; name?: { value: string } }[] }>(
          "Accessibility.getPartialAXTree",
          { backendNodeId, fetchRelatives: false },
        )
        .catch(() => ({ nodes: [] }));
      role = tree.nodes[0]?.role?.value;
      name = tree.nodes[0]?.name?.value;
    }
    const node = await cdp
      .send<{ node: { attributes?: string[] } }>("DOM.describeNode", { backendNodeId })
      .catch(() => ({ node: {} as { attributes?: string[] } }));
    const attrs = node.node.attributes ?? [];
    const secret =
      attrs.findIndex((a, i) => i % 2 === 0 && a === "type" && attrs[i + 1] === "password") >= 0;
    let loginOrigin: string | undefined;
    if (secret && url?.startsWith("https://")) {
      try {
        const expected = new URL(url).origin;
        const [snapshot, tree] = await Promise.all([
          cdp.send<{ strings: string[]; documents: { documentURL: number }[] }>(
            "DOMSnapshot.captureSnapshot",
            { computedStyles: [] },
          ),
          cdp.send("Accessibility.getFullAXTree", {}),
        ]);
        // Bind to the snapshot's actual top-level document, not a stale title/metrics URL.
        // Passwords inside frames fail the top-level form/node check and are not retained.
        const actual = snapshot.strings[snapshot.documents[0]?.documentURL ?? -1];
        if (actual && new URL(actual).origin === expected) {
          loginForm(snapshot, tree, backendNodeId, expected, true);
          loginOrigin = expected;
        }
      } catch {
        // Native app passwords and unsupported/change-password forms still accept a private
        // one-time answer, but are never auto-filled from the saved website credential store.
      }
    }
    const centre = point ?? {
      x: Math.round(bbox.x + bbox.w / 2),
      y: Math.round(bbox.y + bbox.h / 2),
    };
    return {
      point: centre,
      bbox,
      source: "dom",
      ...(role ? { role: clipText(role, 64) } : {}),
      ...(name ? { name: clipText(name, 64) } : {}),
      app: clipText(win.cls, 128),
      window: clipText(win.title, 256),
      ...(url ? { url: clipText(url, 2048) } : {}),
      ...(secret ? { secret: true } : {}),
      ...(loginOrigin ? { loginOrigin } : {}),
    };
  }

  async hitTest(win: HelperWindow, point: Point): Promise<Target | null> {
    const { cdp } = await this.#session(win);
    const m = await this.#metrics(cdp);
    const origin = await this.#origin(win, m);
    const css = { x: (point.x - origin.x) / m.dpr, y: (point.y - origin.y) / m.dpr };
    if (
      css.x < 0 ||
      css.y < 0 ||
      (m.innerWidth !== undefined && css.x >= m.innerWidth) ||
      (m.innerHeight !== undefined && css.y >= m.innerHeight)
    )
      return null;
    await cdp.send("DOM.getDocument", { depth: 0 });
    const node = await cdp
      .send<{ backendNodeId: number }>("DOM.getNodeForLocation", {
        x: Math.round(css.x),
        y: Math.round(css.y),
        includeUserAgentShadowDOM: false,
      })
      .catch(() => null);
    if (!node) return null;
    return this.#describe(cdp, node.backendNodeId, win, origin, m.dpr, m.url, point);
  }

  async find(win: HelperWindow, req: FindRequest): Promise<Target | null> {
    const { cdp } = await this.#session(win);
    const m = await this.#metrics(cdp);
    const origin = await this.#origin(win, m);
    const doc = await cdp.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
    const q = await cdp
      .send<{
        nodes: { backendDOMNodeId: number; role?: { value: string }; name?: { value: string } }[];
      }>("Accessibility.queryAXTree", {
        nodeId: doc.root.nodeId,
        accessibleName: req.name,
        ...(req.role ? { role: req.role } : {}),
      })
      .catch(() => ({ nodes: [] }));
    const hit = q.nodes[0];
    if (!hit) return null;
    return this.#describe(cdp, hit.backendDOMNodeId, win, origin, m.dpr, m.url, undefined, {
      role: hit.role?.value,
      name: hit.name?.value,
    });
  }

  // A page element by its DevTools node, where it is now; null once none of it is in view.
  async node(win: HelperWindow, backendNodeId: number): Promise<Target | null> {
    const { cdp } = await this.#session(win);
    const m = await this.#metrics(cdp);
    const origin = await this.#origin(win, m);
    const tree = await cdp
      .send<{ nodes: AxNode[] }>("Accessibility.getPartialAXTree", {
        backendNodeId,
        fetchRelatives: false,
      })
      .catch(() => ({ nodes: [] as AxNode[] }));
    const ax = tree.nodes.find((n) => n.backendDOMNodeId === backendNodeId) ?? tree.nodes[0];
    const target = await this.#describe(cdp, backendNodeId, win, origin, m.dpr, m.url, undefined, {
      role: ax?.role?.value ?? "",
      name: ax?.name?.value ?? "",
    });
    const shown = target?.bbox && visiblePart(target.bbox, origin, m);
    if (!target || !shown) return null;
    const checked = ax && stateOf(ax, false).checked;
    return {
      ...target,
      bbox: shown,
      point: { x: Math.round(shown.x + shown.w / 2), y: Math.round(shown.y + shown.h / 2) },
      ...(checked ? { checked } : {}),
    };
  }

  // The page's interactive elements at least partly in view, in document order, with their
  // DevTools nodes; boxes cut to the viewport.
  async elements(
    win: HelperWindow,
    limit: number,
  ): Promise<{
    url: string | undefined;
    // Where the page starts: Chromium's own controls are above it.
    origin: Point;
    elements: WireElement[];
    truncated: boolean;
  }> {
    const { cdp } = await this.#session(win);
    const m = await this.#metrics(cdp);
    const origin = await this.#origin(win, m);
    const tree = await cdp.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree", {});
    const seen = new Set<number>();
    const candidates = tree.nodes.filter((n) => {
      const id = n.backendDOMNodeId;
      if (n.ignored || !id || seen.has(id) || !INTERACTIVE.has(n.role?.value ?? "")) return false;
      seen.add(id);
      return true;
    });
    // Document order is not screen order: on a page scrolled down, what is in view comes late.
    const boxed = candidates.slice(0, MAX_BOXED);
    const shown: { n: AxNode; bbox: Rect }[] = [];
    for (let start = 0; start < boxed.length; start += BOX_BATCH) {
      const batch = boxed.slice(start, start + BOX_BATCH);
      const boxes = await Promise.all(
        batch.map((n) =>
          cdp
            .send<{ model: { border: number[] } }>("DOM.getBoxModel", {
              backendNodeId: n.backendDOMNodeId,
            })
            .catch(() => null),
        ),
      );
      for (const [i, n] of batch.entries()) {
        const box = boxes[i];
        const bbox = box && visiblePart(quadToRect(box.model.border, origin, m.dpr), origin, m);
        if (bbox) shown.push({ n, bbox });
      }
    }
    shown.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    const elements = await Promise.all(
      shown.slice(0, limit).map(async ({ n, bbox }): Promise<WireElement> => {
        const role = n.role?.value ?? "";
        const secret =
          (role === "textbox" || role === "searchbox") &&
          (await this.#password(cdp, n.backendDOMNodeId as number));
        const name = n.name?.value ?? "";
        const state = stateOf(n, secret);
        return {
          point: { x: Math.round(bbox.x + bbox.w / 2), y: Math.round(bbox.y + bbox.h / 2) },
          bbox,
          source: "dom",
          role: clipText(role, 64),
          ...(name ? { name: clipText(name, 64) } : {}),
          app: clipText(win.cls, 128),
          window: clipText(win.title, 256),
          ...(m.url ? { url: clipText(m.url, 2048) } : {}),
          ...(secret ? { secret: true } : {}),
          node: n.backendDOMNodeId as number,
          ...(Object.keys(state).length ? { state } : {}),
        };
      }),
    );
    return {
      url: m.url,
      origin,
      elements,
      truncated: shown.length > limit || candidates.length > boxed.length,
    };
  }

  async #password(cdp: CdpOperation, backendNodeId: number): Promise<boolean> {
    const node = await cdp
      .send<{ node: { attributes?: string[] } }>("DOM.describeNode", { backendNodeId })
      .catch(() => ({ node: {} as { attributes?: string[] } }));
    const attrs = node.node.attributes ?? [];
    return attrs.some((a, i) => i % 2 === 0 && a === "type" && attrs[i + 1] === "password");
  }

  async focused(win: HelperWindow): Promise<Target | null> {
    const { cdp } = await this.#session(win);
    const m = await this.#metrics(cdp);
    const origin = await this.#origin(win, m);
    const active = await cdp.send<{ result: { objectId?: string; subtype?: string } }>(
      "Runtime.evaluate",
      {
        expression: "document.hasFocus() ? document.activeElement : null",
        objectGroup: "localdot-focus",
      },
    );
    const objectId = active.result.objectId;
    if (!objectId || active.result.subtype === "null") return null;
    try {
      const node = await cdp.send<{ node: { backendNodeId: number } }>("DOM.describeNode", {
        objectId,
      });
      return await this.#describe(cdp, node.node.backendNodeId, win, origin, m.dpr, m.url);
    } finally {
      await cdp
        .send("Runtime.releaseObjectGroup", { objectGroup: "localdot-focus" })
        .catch(() => {});
    }
  }

  async close(): Promise<void> {
    for (const s of this.#sessions.values()) s.close();
    this.#sessions.clear();
    this.#origins.clear();
  }
}
