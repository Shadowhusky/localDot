import {
  clipText,
  type FindRequest,
  type HitTestResult,
  type Point,
  type Rect,
  type Target,
} from "@localdot/protocol";
import type { XHelper } from "../x/helper.ts";
import type { Screenshots } from "./capture.ts";
import type { ChromiumPerception } from "./cdp.ts";
import type { CuaDriver, DriverElement } from "./driver.ts";
import { appToolkit, elementToolkit, frameToDevice, menuBarHeight } from "./mapping.ts";
import type { NativeAccessibility, NativeElement } from "./native.ts";

export interface HelperWindow {
  id: number;
  pid: number;
  cls: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  frame: [number, number, number, number];
  active: boolean;
  overrideRedirect: boolean;
  transientFor: number | null;
}

export interface PerceptionDeps {
  x: XHelper;
  driver: CuaDriver;
  screenshots?: Screenshots;
  cdp?: ChromiumPerception;
  native?: NativeAccessibility;
  scale: 1 | 2;
  readScaling(): Promise<number>;
}

const TREE_TIMEOUT_MS = 2500;
// find walks window after window; it stops inside the daemon client's 5 s find timeout.
const FIND_BUDGET_MS = 4000;

const contains = (r: Rect, p: Point) =>
  p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
const area = (r: Rect) => r.w * r.h;

// Every window top first, open menus and popups included, and the screen's change generation,
// which moves with every damage, map, unmap and move.
export function windowStack(x: XHelper): Promise<{ windows: HelperWindow[]; generation: number }> {
  return x.call<{ windows: HelperWindow[]; generation: number }>("windows", { stack: true });
}

export async function listWindows(x: XHelper): Promise<HelperWindow[]> {
  return (await windowStack(x)).windows;
}

// The panel, the dock and the desktop window (the classes the Task 3 windows test filters) are
// never "the app under the point": a point on the panel strut has no window, so hitTest returns
// a null target and the gateway keeps the crosshair; find never searches them either.
export const DECOR_CLASSES = new Set(["Xfce4-panel", "Plank", "Xfdesktop"]);

// The top-most window at the point, open menus and popups included: input goes to it.
export function windowUnder(windows: HelperWindow[], point: Point): HelperWindow | undefined {
  return windows.find(
    (w) =>
      !DECOR_CLASSES.has(w.cls) &&
      contains({ x: w.frame[0], y: w.frame[1], w: w.frame[2], h: w.frame[3] }, point),
  );
}

interface Mapped {
  el: DriverElement;
  rect: Rect;
}

// Every frame through its toolkit's transform; web content is left to CDP (chromium-web throws).
export function mapTree(
  elements: DriverElement[],
  cls: string,
  params: { g: number; c: number; windowOrigin: Point },
): Mapped[] {
  const app = appToolkit(cls);
  const byIndex = new Map(elements.map((e) => [e.element_index, e]));
  const ancestorsOf = (e: DriverElement): string[] => {
    const roles: string[] = [];
    let p = e.parent_index === undefined ? undefined : byIndex.get(e.parent_index);
    for (let i = 0; p && i < 64; i++) {
      roles.push(p.role);
      p = p.parent_index === undefined ? undefined : byIndex.get(p.parent_index);
    }
    return roles;
  };
  const m = menuBarHeight(elements);
  const out: Mapped[] = [];
  for (const el of elements) {
    if (!el.frame) continue;
    const toolkit = elementToolkit(
      app,
      { role: el.role, inWeb: el.in_web_content === true },
      ancestorsOf(el),
    );
    if (toolkit === "chromium-web") continue;
    out.push({ el, rect: frameToDevice(el.frame, toolkit, { ...params, m }) });
  }
  return out;
}

function targetFrom(
  point: Point,
  win: HelperWindow,
  mapped: Mapped | undefined,
  source: Target["source"],
): Target {
  const base: Target = {
    point,
    source,
    app: clipText(win.cls, 128),
    window: clipText(win.title, 256),
  };
  if (!mapped) return base;
  const { el, rect } = mapped;
  return {
    ...base,
    bbox: rect,
    role: clipText(el.role, 64),
    ...(el.label ? { name: clipText(el.label, 64) } : {}),
    ...(el.role === "password text" ? { secret: true } : {}),
  };
}

async function nativeTarget(
  deps: PerceptionDeps,
  win: HelperWindow,
  el: NativeElement,
): Promise<Target> {
  const toolkit = elementToolkit(
    appToolkit(win.cls),
    { role: el.role, inWeb: false },
    el.ancestorRoles,
  );
  const frame = frameToDevice(el.frame, toolkit, {
    g: await deps.readScaling(),
    c: deps.scale,
    m: 25,
    windowOrigin: { x: win.x, y: win.y },
  });
  return targetFrom(
    { x: Math.round(frame.x + frame.w / 2), y: Math.round(frame.y + frame.h / 2) },
    win,
    { el: { element_index: 0, role: el.role, label: el.name, depth: el.depth }, rect: frame },
    "ax",
  );
}

// Keyboard focus, not the pointer, determines whether text can be logged. Unknown focus is
// returned explicitly so the gateway can mask it conservatively.
export async function focusedTarget(deps: PerceptionDeps): Promise<HitTestResult> {
  const start = performance.now();
  const win = (await listWindows(deps.x)).find((w) => w.active && !DECOR_CLASSES.has(w.cls));
  let target: Target | null = null;
  if (win) {
    if (appToolkit(win.cls) === "chromium" && deps.cdp) {
      target = await deps.cdp.focused(win).catch(() => null);
    }
    if (!target && deps.native) {
      const el = await deps.native.query(win, "focused").catch(() => null);
      if (el) target = await nativeTarget(deps, win, el);
    }
  }
  return { target, window: win?.id ?? null, ms: Math.round(performance.now() - start) };
}

export async function hitTest(deps: PerceptionDeps, point: Point): Promise<HitTestResult> {
  const t0 = performance.now();
  const windows = await listWindows(deps.x);
  const win = windowUnder(windows, point);
  const done = (target: Target | null, window: number | null): HitTestResult => ({
    target,
    window,
    ms: Math.round(performance.now() - t0),
  });
  if (!win) return done(null, null);
  const client = { x: win.x, y: win.y, w: win.w, h: win.h };
  if (!contains(client, point)) return done(targetFrom(point, win, undefined, "coords"), win.id);
  if (appToolkit(win.cls) === "libreoffice" && deps.native) {
    const el = await deps.native.query(win, "namebox").catch(() => null);
    if (el) {
      const target = await nativeTarget(deps, win, el);
      if (target.bbox && contains(target.bbox, point)) return done({ ...target, point }, win.id);
    }
  }
  if (appToolkit(win.cls) === "chromium" && deps.cdp) {
    const web = await deps.cdp.hitTest(win, point).catch(() => null);
    if (web) return done(web, win.id);
  }
  const g = await deps.readScaling();
  const c = await chromeScale(deps, win);
  const state = await deps.driver.windowState(win.pid, win.id, TREE_TIMEOUT_MS);
  const mapped = mapTree(state.elements, win.cls, { g, c, windowOrigin: { x: win.x, y: win.y } });
  const hits = mapped
    .filter((m) => contains(m.rect, point))
    .sort((a, b) => area(a.rect) - area(b.rect) || b.el.depth - a.el.depth);
  return done(targetFrom(point, win, hits[0], hits[0] ? "ax" : "coords"), win.id);
}

// Chromium's own chrome scales by its device scale factor (D13); every other toolkit ignores `c`,
// so only a Chromium window is worth a CDP round trip.
async function chromeScale(deps: PerceptionDeps, win: HelperWindow): Promise<number> {
  if (appToolkit(win.cls) !== "chromium" || !deps.cdp) return deps.scale;
  return deps.cdp.deviceScaleFactor(win).catch(() => deps.scale);
}

export async function findTarget(deps: PerceptionDeps, req: FindRequest): Promise<HitTestResult> {
  const t0 = performance.now();
  const wanted = req.name.toLowerCase();
  const windows = (await listWindows(deps.x)).filter(
    (w) => !DECOR_CLASSES.has(w.cls) && (!req.app || w.cls.toLowerCase() === req.app.toLowerCase()),
  );
  const g = await deps.readScaling();
  for (const win of windows) {
    const left = FIND_BUDGET_MS - (performance.now() - t0);
    if (left <= 0) break;
    if (appToolkit(win.cls) === "libreoffice" && wanted === "name box" && deps.native) {
      const el = await deps.native.query(win, "namebox").catch(() => null);
      if (el && (!req.role || req.role === el.role)) {
        return {
          target: await nativeTarget(deps, win, el),
          window: win.id,
          ms: Math.round(performance.now() - t0),
        };
      }
    }
    if (appToolkit(win.cls) === "chromium" && deps.cdp) {
      const web = await deps.cdp.find(win, req).catch(() => null);
      if (web) return { target: web, window: win.id, ms: Math.round(performance.now() - t0) };
      continue;
    }
    const state = await deps.driver.windowState(win.pid, win.id, Math.min(TREE_TIMEOUT_MS, left));
    const mapped = mapTree(state.elements, win.cls, {
      g,
      c: deps.scale,
      windowOrigin: { x: win.x, y: win.y },
    });
    const match =
      mapped.find(
        (m) => (m.el.label ?? "").toLowerCase() === wanted && (!req.role || m.el.role === req.role),
      ) ??
      mapped.find(
        (m) =>
          (m.el.label ?? "").toLowerCase().startsWith(wanted) &&
          (!req.role || m.el.role === req.role),
      );
    if (match) {
      const point = {
        x: Math.round(match.rect.x + match.rect.w / 2),
        y: Math.round(match.rect.y + match.rect.h / 2),
      };
      return {
        target: targetFrom(point, win, match, "ax"),
        window: win.id,
        ms: Math.round(performance.now() - t0),
      };
    }
  }
  return { target: null, window: null, ms: Math.round(performance.now() - t0) };
}
