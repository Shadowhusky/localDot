import {
  clipText,
  type ElementsRequest,
  type ElementsResult,
  type FindRequest,
  type HitTestResult,
  type Point,
  type Rect,
  type Target,
  type WireElement,
} from "@localdot/protocol";
import type { XHelper } from "../x/helper.ts";
import type { Screenshots } from "./capture.ts";
import type { ChromiumPerception } from "./cdp.ts";
import type { CuaDriver } from "./driver.ts";
import { appToolkit, frameToDevice } from "./mapping.ts";
import {
  type NativeAccessibility,
  type NativeElement,
  type NativeQuery,
  within,
} from "./native.ts";

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

// Each action reads its identity twice: past this the accessibility helper answers "unknown"
// rather than hold the action.
export const NATIVE_BUDGET_MS = 300;
// A whole lookup answers within this, well inside the daemon's 1 s backstop: a part that misses it
// (a slow CDP round trip, a busy helper) leaves the element unknown, with its window.
export const LOOKUP_BUDGET_MS = 600;
// find walks window after window; it stops inside the daemon client's 5 s find timeout.
const FIND_BUDGET_MS = 4000;
const TREE_BUDGET_MS = 1500;

const contains = (r: Rect, p: Point) =>
  p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
const frameOf = (w: HelperWindow): Rect => ({
  x: w.frame[0],
  y: w.frame[1],
  w: w.frame[2],
  h: w.frame[3],
});

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
  return windows.find((w) => !DECOR_CLASSES.has(w.cls) && contains(frameOf(w), point));
}

async function nativeQuery(
  deps: PerceptionDeps,
  win: HelperWindow,
  windows: HelperWindow[],
): Promise<NativeQuery> {
  const parent =
    win.overrideRedirect && win.transientFor !== null
      ? windows.find((w) => w.id === win.transientFor)
      : undefined;
  return {
    kit: appToolkit(win.cls),
    g: await deps.readScaling(),
    c: await chromeScale(deps, win),
    ...(parent ? { parent } : {}),
  };
}

// Chromium's own chrome scales by its device scale factor (D13); every other toolkit ignores `c`,
// so only a Chromium window is worth a CDP round trip.
async function chromeScale(deps: PerceptionDeps, win: HelperWindow): Promise<number> {
  if (appToolkit(win.cls) !== "chromium" || !deps.cdp) return deps.scale;
  return deps.cdp.deviceScaleFactor(win).catch(() => deps.scale);
}

function windowTarget(point: Point, win: HelperWindow): Target {
  return {
    point,
    source: "coords",
    app: clipText(win.cls, 128),
    window: clipText(win.title, 256),
  };
}

function elementTarget(win: HelperWindow, el: NativeElement, q: NativeQuery): Target {
  const bbox = frameToDevice(el.frame, el.space, {
    g: q.g,
    c: q.c,
    windowOrigin: { x: win.x, y: win.y },
  });
  return {
    point: { x: Math.round(bbox.x + bbox.w / 2), y: Math.round(bbox.y + bbox.h / 2) },
    bbox,
    source: "ax",
    app: clipText(win.cls, 128),
    window: clipText(win.title, 256),
    role: clipText(el.role, 64),
    ...(el.name ? { name: clipText(el.name, 64) } : {}),
    ...(el.secret ? { secret: true } : {}),
    ...(el.editable ? { editable: true } : {}),
  };
}

// Keyboard focus, not the pointer, determines whether text can be logged. A lookup that ran out of
// time is reported as unknown, so the gateway can mask it conservatively.
export async function focusedTarget(deps: PerceptionDeps): Promise<HitTestResult> {
  const t0 = performance.now();
  const left = () => LOOKUP_BUDGET_MS - (performance.now() - t0);
  const windows = await listWindows(deps.x);
  const win = windows.find((w) => w.active && !DECOR_CLASSES.has(w.cls));
  const done = (target: Target | null, unknown = false): HitTestResult => ({
    target,
    window: win?.id ?? null,
    ...(win ? { windowFrame: frameOf(win) } : {}),
    ...(unknown ? { unknown: true as const } : {}),
    ms: Math.round(performance.now() - t0),
  });
  if (!win) return done(null);
  if (appToolkit(win.cls) === "chromium" && deps.cdp) {
    const focus = deps.cdp.focused(win).catch(() => null);
    const web = await within(focus, left());
    if (web === undefined) return done(null, true);
    if (web) return done(web);
  }
  if (!deps.native) return done(null);
  const q = await within(nativeQuery(deps, win, windows), left());
  if (!q) return done(null, true);
  const answer =
    (await within(deps.native.focused(win, q, Math.min(NATIVE_BUDGET_MS, left())), left())) ??
    ({ unknown: true } as const);
  if ("unknown" in answer) return done(null, true);
  return done(answer.element ? elementTarget(win, answer.element, q) : null);
}

// `managed` looks through override-redirect windows: during a drag, its own icon is at the pointer.
export async function hitTest(
  deps: PerceptionDeps,
  point: Point,
  managed = false,
): Promise<HitTestResult> {
  const t0 = performance.now();
  const left = () => LOOKUP_BUDGET_MS - (performance.now() - t0);
  const windows = await listWindows(deps.x);
  const win = windowUnder(managed ? windows.filter((w) => !w.overrideRedirect) : windows, point);
  const done = (target: Target | null, unknown = false): HitTestResult => ({
    target,
    window: win?.id ?? null,
    ...(win ? { windowFrame: frameOf(win) } : {}),
    ...(unknown ? { unknown: true as const } : {}),
    ms: Math.round(performance.now() - t0),
  });
  if (!win) return done(null);
  const client = { x: win.x, y: win.y, w: win.w, h: win.h };
  if (!contains(client, point) || !deps.native) return done(windowTarget(point, win));
  // Web content is CDP's and wins; Chromium's own UI is the helper's. Both run at once.
  const web =
    appToolkit(win.cls) === "chromium" && deps.cdp
      ? deps.cdp.hitTest(win, point).catch(() => null)
      : null;
  const q = await within(nativeQuery(deps, win, windows), left());
  if (!q) return done(windowTarget(point, win), true);
  const answer =
    (await within(deps.native.at(win, point, q, Math.min(NATIVE_BUDGET_MS, left())), left())) ??
    ({ unknown: true } as const);
  const page = web ? await within(web, left()) : null;
  if (page === undefined) return done(windowTarget(point, win), true);
  if (page) return done(page);
  if ("unknown" in answer) return done(windowTarget(point, win), true);
  const target = answer.element ? elementTarget(win, answer.element, q) : undefined;
  if (!target?.bbox || !contains(target.bbox, point)) return done(windowTarget(point, win));
  return done({ ...target, point });
}

// The front Chromium window: the page browser_read reads and browser_act acts on.
function frontChromium(windows: HelperWindow[]): HelperWindow | undefined {
  return windows.find((w) => appToolkit(w.cls) === "chromium" && !w.overrideRedirect);
}

// A page element by its node, only while it keeps the role and name it was listed with, on the
// page it was listed on.
async function nodeTarget(
  deps: PerceptionDeps,
  req: FindRequest & { node: number },
): Promise<HitTestResult> {
  const t0 = performance.now();
  const win = frontChromium(await listWindows(deps.x));
  const target = win && deps.cdp ? await deps.cdp.node(win, req.node).catch(() => null) : null;
  const same =
    target &&
    (req.role === undefined || (target.role ?? "") === req.role) &&
    (req.name === undefined || (target.name ?? "") === req.name) &&
    (req.url === undefined || target.url === req.url);
  return same && win
    ? { target, window: win.id, windowFrame: frameOf(win), ms: Math.round(performance.now() - t0) }
    : { target: null, window: null, ms: Math.round(performance.now() - t0) };
}

export async function findTarget(deps: PerceptionDeps, req: FindRequest): Promise<HitTestResult> {
  if (req.node !== undefined) return nodeTarget(deps, { ...req, node: req.node });
  const t0 = performance.now();
  const wanted = (req.name ?? "").toLowerCase();
  const { windows, generation } = await windowStack(deps.x);
  const searched = windows.filter(
    (w) => !DECOR_CLASSES.has(w.cls) && (!req.app || w.cls.toLowerCase() === req.app.toLowerCase()),
  );
  const found = (target: Target, win: HelperWindow): HitTestResult => ({
    target,
    window: win.id,
    windowFrame: frameOf(win),
    ms: Math.round(performance.now() - t0),
  });
  for (const win of searched) {
    const left = FIND_BUDGET_MS - (performance.now() - t0);
    if (left <= 0) break;
    if (appToolkit(win.cls) === "chromium" && deps.cdp) {
      const web = await deps.cdp.find(win, req).catch(() => null);
      if (web) return found(web, win);
    }
    if (!deps.native) continue;
    const q = await nativeQuery(deps, win, windows);
    const tree = await deps.native.tree(win, q, Math.min(TREE_BUDGET_MS, left), generation);
    if ("unknown" in tree) continue;
    const role = (el: NativeElement) => !req.role || el.role === req.role;
    const match =
      tree.elements.find((el) => el.name.toLowerCase() === wanted && role(el)) ??
      tree.elements.find((el) => el.name.toLowerCase().startsWith(wanted) && role(el));
    if (match) return found(elementTarget(win, match, q), win);
  }
  return { target: null, window: null, ms: Math.round(performance.now() - t0) };
}

// How well a name answers a search: whole, from its start, from a word's start, or inside it.
function rank(name: string, wanted: string): number | undefined {
  const lower = name.toLowerCase();
  if (lower === wanted) return 0;
  if (lower.startsWith(wanted)) return 1;
  const at = lower.indexOf(wanted);
  if (at < 0) return undefined;
  return /[\p{L}\p{N}]/u.test(lower[at - 1] ?? "") ? 3 : 2;
}

// The controls whose names contain the text, best matches first and then top window first: the
// apps' own accessibility trees, and in a Chromium window its page's interactive elements too.
export async function findElements(
  deps: PerceptionDeps,
  req: ElementsRequest,
): Promise<ElementsResult> {
  const t0 = performance.now();
  const limit = req.limit ?? 30;
  const wanted = (req.text ?? "").toLowerCase();
  const role = req.role?.toLowerCase();
  const { windows, generation } = await windowStack(deps.x);
  const found: { element: WireElement; rank: number }[] = [];
  const consider = (element: WireElement) => {
    const r = rank(element.name ?? "", wanted);
    if (r === undefined || (role && !(element.role ?? "").toLowerCase().includes(role))) return;
    found.push({ element, rank: r });
  };
  let cut = false;
  for (const win of windows.filter((w) => !DECOR_CLASSES.has(w.cls))) {
    const left = FIND_BUDGET_MS - (performance.now() - t0);
    if (left <= 0) {
      cut = true;
      break;
    }
    // A Chromium window's page is CDP's; its tree's page part is in other units, so only the
    // browser's own controls above the page are taken from the tree, and nothing without CDP.
    let above = Number.POSITIVE_INFINITY;
    if (appToolkit(win.cls) === "chromium" && !win.overrideRedirect) {
      const page = deps.cdp ? await deps.cdp.elements(win, 300).catch(() => undefined) : undefined;
      if (!page) continue;
      for (const element of page.elements) consider(element);
      above = page.origin.y;
    }
    if (!deps.native) continue;
    const q = await nativeQuery(deps, win, windows);
    const tree = await deps.native.tree(win, q, Math.min(TREE_BUDGET_MS, left), generation);
    if ("unknown" in tree) {
      cut = true;
      continue;
    }
    for (const el of tree.elements) {
      const target = elementTarget(win, el, q);
      if (target.point.y < above) consider(target);
    }
  }
  const best = found.sort((a, b) => a.rank - b.rank).map((f) => f.element);
  return { elements: best.slice(0, limit), truncated: cut || best.length > limit };
}

// The front Chromium page's interactive elements in view, as browser_read lists them.
export async function pageElements(
  deps: PerceptionDeps,
  req: ElementsRequest,
): Promise<ElementsResult> {
  const win = frontChromium(await listWindows(deps.x));
  if (!win || !deps.cdp) return { elements: [], truncated: false };
  const page = await deps.cdp.elements(win, req.limit ?? 30);
  return {
    elements: page.elements,
    ...(page.url ? { url: page.url } : {}),
    truncated: page.truncated,
  };
}
