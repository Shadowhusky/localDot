import type { Point, Rect, Target, WireElement } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { XHelper } from "../x/helper.ts";
import type { ChromiumPerception } from "./cdp.ts";
import type { CuaDriver } from "./driver.ts";
import {
  findElements,
  findTarget,
  focusedTarget,
  type HelperWindow,
  hitTest,
  LOOKUP_BUDGET_MS,
  NATIVE_BUDGET_MS,
  type PerceptionDeps,
  pageElements,
} from "./hit-test.ts";
import type {
  NativeAccessibility,
  NativeAnswer,
  NativeElement,
  NativeQuery,
  NativeTree,
} from "./native.ts";

const win = (
  id: number,
  cls: string,
  x: number,
  y: number,
  w: number,
  h: number,
  over: Partial<HelperWindow> = {},
): HelperWindow => ({
  id,
  pid: 10 * id,
  cls,
  title: `${cls} window`,
  x,
  y,
  w,
  h,
  frame: [x - 1, y - 24, w + 2, h + 25],
  active: id === 1,
  overrideRedirect: false,
  transientFor: null,
  ...over,
});

const el = (
  role: string,
  name: string,
  frame: Rect,
  over: Partial<NativeElement> = {},
): NativeElement => ({
  role,
  name,
  frame,
  space: "gtk",
  secret: false,
  editable: false,
  ...over,
});

interface Asked {
  cmd: string;
  win: number;
  point?: Point;
  q: NativeQuery;
  budget: number;
  generation?: number;
}

// A scripted accessibility helper: answers per window and records what it was asked.
function fakeNative(answers: {
  at?: (win: HelperWindow, point: Point) => NativeAnswer | Promise<NativeAnswer>;
  focused?: (win: HelperWindow) => NativeAnswer | Promise<NativeAnswer>;
  tree?: (win: HelperWindow) => NativeTree;
}): NativeAccessibility & { asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    async at(w, point, q, budget) {
      asked.push({ cmd: "at", win: w.id, point, q, budget });
      return answers.at?.(w, point) ?? { element: null };
    },
    async focused(w, q, budget) {
      asked.push({ cmd: "focused", win: w.id, q, budget });
      return answers.focused?.(w) ?? { element: null };
    },
    async tree(w, q, budget, generation) {
      asked.push({ cmd: "tree", win: w.id, q, budget, generation });
      return answers.tree?.(w) ?? { elements: [] };
    },
    async content() {
      return null;
    },
  };
}

function deps(
  windows: HelperWindow[],
  native?: NativeAccessibility,
  extra: Partial<PerceptionDeps> = {},
): PerceptionDeps & { stackCalls: Record<string, unknown>[] } {
  const stackCalls: Record<string, unknown>[] = [];
  const x = {
    call: async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd !== "windows") return {};
      stackCalls.push(args);
      return { windows, generation: 41 };
    },
  } as unknown as XHelper;
  return {
    x,
    driver: {} as CuaDriver,
    ...(native ? { native } : {}),
    scale: 2,
    readScaling: async () => 2,
    stackCalls,
    ...extra,
  };
}

const IMAGE = win(11, "Gimp", 2, 110, 1600, 1200);

describe("hitTest", () => {
  it("asks the helper about the top-most window's point and maps its element to device pixels", async () => {
    // The terminal (active, on top) overlaps Thunar.
    const terminal = win(1, "Xfce4-terminal", 500, 300, 800, 600);
    const thunar = win(2, "Thunar", 1, 78, 1280, 960);
    const native = fakeNative({
      at: (w) =>
        w.id === 2
          ? { element: el("menu", "File", { x: 0, y: 39, w: 39, h: 27 }) }
          : { element: el("terminal", "", { x: 250, y: 150, w: 400, h: 300 }) },
    });
    const d = deps([terminal, thunar], native);
    // (20,100) is outside the terminal's frame; the File menu at frame (0,39,39,27) maps to device
    // (1,78,78,54) with origin (1,78), g = 2.
    const hit = await hitTest(d, { x: 20, y: 100 });
    expect(hit).toMatchObject({ window: 2, windowFrame: { x: 0, y: 54, w: 1282, h: 985 } });
    expect(hit.unknown).toBeUndefined();
    expect(hit.target).toMatchObject({
      point: { x: 20, y: 100 },
      source: "ax",
      role: "menu",
      name: "File",
      app: "Thunar",
      window: "Thunar window",
      bbox: { x: 1, y: 78, w: 78, h: 54 },
    });
    expect(native.asked).toEqual([
      {
        cmd: "at",
        win: 2,
        point: { x: 20, y: 100 },
        q: { kit: "gtk", g: 2, c: 2 },
        budget: NATIVE_BUDGET_MS,
      },
    ]);
    expect(d.stackCalls).toEqual([{ stack: true }]);
    expect((await hitTest(d, { x: 600, y: 400 })).window).toBe(1);
  });

  it("reports an open menu over its parent window, and passes the parent along", async () => {
    const menu = win(30, "Gimp", -10, 150, 640, 1108, {
      frame: [-10, 150, 640, 1108],
      overrideRedirect: true,
      transientFor: 11,
      title: "",
    });
    const native = fakeNative({
      at: (w) =>
        w.id === 30
          ? { element: el("menu item", "Open...", { x: 7, y: 136, w: 296, h: 25 }) }
          : { element: null },
    });
    const hit = await hitTest(deps([menu, IMAGE], native), { x: 115, y: 296 });
    expect(hit.window).toBe(30);
    expect(hit.target).toMatchObject({ role: "menu item", name: "Open...", source: "ax" });
    expect(native.asked[0]?.q.parent?.id).toBe(11);
  });

  it("names whatever window input would go to, a window another app holds over a button too", async () => {
    // An override-redirect window over the image window takes the press, whatever it claims to be.
    const cover = win(31, "Other", 100, 280, 300, 60, {
      frame: [100, 280, 300, 60],
      overrideRedirect: true,
    });
    const hit = await hitTest(deps([cover, IMAGE], fakeNative({})), { x: 115, y: 296 });
    expect(hit.window).toBe(31);
    expect(hit.target).toMatchObject({ app: "Other", source: "coords" });
  });

  it("looks through a drag's own icon to the managed window under it when asked", async () => {
    const icon = win(90, "Thunar", 100, 280, 48, 48, {
      frame: [100, 280, 48, 48],
      overrideRedirect: true,
      title: "",
    });
    const native = fakeNative({
      at: (w) =>
        w.id === 11
          ? { element: el("list item", "Trash", { x: 50, y: 140, w: 30, h: 20 }) }
          : { element: null },
    });
    const d = deps([icon, IMAGE], native);
    expect((await hitTest(d, { x: 115, y: 296 })).window).toBe(90);
    const under = await hitTest(d, { x: 115, y: 296 }, true);
    expect(under.window).toBe(11);
    expect(under.target).toMatchObject({ name: "Trash", role: "list item" });
  });

  it("keeps the window when the lookup runs out of time, and says it is unknown", async () => {
    const native = fakeNative({ at: () => ({ unknown: true }) });
    const hit = await hitTest(deps([IMAGE], native), { x: 40, y: 250 });
    expect(hit).toMatchObject({
      window: 11,
      windowFrame: { x: 1, y: 86, w: 1602, h: 1225 },
      unknown: true,
      target: { source: "coords", app: "Gimp", point: { x: 40, y: 250 } },
    });
  });

  it("treats no element, or one that misses the point, as a complete window-level answer", async () => {
    for (const answer of [
      { element: null },
      { element: el("button", "Elsewhere", { x: 500, y: 500, w: 10, h: 10 }) },
    ]) {
      const native = fakeNative({ at: () => answer });
      const hit = await hitTest(deps([IMAGE], native), { x: 40, y: 250 });
      expect(hit.target).toMatchObject({ source: "coords" });
      expect(hit.unknown).toBeUndefined();
    }
  });

  it("returns a coordinates-only target on a window's decoration and nothing on empty desktop", async () => {
    const native = fakeNative({});
    const d = deps([win(2, "Thunar", 1, 78, 1280, 960)], native);
    const title = await hitTest(d, { x: 100, y: 60 });
    expect(title.target).toMatchObject({ source: "coords", app: "Thunar" });
    expect(title.target?.bbox).toBeUndefined();
    const nothing = await hitTest(d, { x: 2500, y: 1500 });
    expect(nothing).toEqual({ target: null, window: null, ms: expect.any(Number) });
    expect(native.asked).toEqual([]);
  });

  it("never names the panel, the dock or the desktop as the window under a point", async () => {
    const native = fakeNative({});
    const panel = win(9, "Xfce4-panel", 0, 0, 2560, 54);
    const onPanel = await hitTest(deps([panel, win(2, "Thunar", 1, 78, 1280, 960)], native), {
      x: 100,
      y: 20,
    });
    expect(onPanel.target).toBeNull();
    expect(onPanel.window).toBeNull();
    expect(native.asked).toEqual([]);
  });

  it("flags secret and editable fields and clips long names", async () => {
    const native = fakeNative({
      at: () => ({
        element: el(
          "password text",
          "x".repeat(200),
          { x: 10, y: 40, w: 100, h: 20 },
          { secret: true, editable: true },
        ),
      }),
    });
    // GTK3 with origin (0,54), g = 2: device = (0,54) + ((10,40) − (0,27)) × 2 = (20,80), size 200×40.
    const hit = await hitTest(deps([win(3, "Mousepad", 0, 54, 1000, 800)], native), {
      x: 50,
      y: 90,
    });
    expect(hit.target?.bbox).toEqual({ x: 20, y: 80, w: 200, h: 40 });
    expect(hit.target).toMatchObject({ secret: true, editable: true });
    expect(hit.target?.name?.length).toBe(64);
    expect(hit.target?.name?.endsWith("…")).toBe(true);
  });

  it("maps Chromium's own UI by its device scale factor after CDP has looked", async () => {
    const chromium = win(4, "Chromium", 0, 54, 2560, 1414, { frame: [0, 54, 2560, 1414] });
    const native = fakeNative({
      at: () => ({
        element: el("button", "Reload", { x: 78, y: 73, w: 34, h: 34 }, { space: "chrome" }),
      }),
    });
    const looked: Point[] = [];
    const cdp = {
      hitTest: async (_w: HelperWindow, p: Point) => {
        looked.push(p);
        return null;
      },
      deviceScaleFactor: async () => 2,
    } as unknown as ChromiumPerception;
    const hit = await hitTest(deps([chromium], native, { cdp }), { x: 189, y: 179 });
    expect(looked).toEqual([{ x: 189, y: 179 }]);
    expect(hit.target).toMatchObject({
      role: "button",
      name: "Reload",
      bbox: { x: 156, y: 146, w: 68, h: 68 },
    });
    expect(native.asked[0]?.q).toEqual({ kit: "chromium", g: 2, c: 2 });
    const link = { point: { x: 900, y: 700 }, source: "dom" as const, role: "link", name: "Docs" };
    const page = {
      hitTest: async () => link,
      deviceScaleFactor: async () => 2,
    } as unknown as ChromiumPerception;
    expect(
      (await hitTest(deps([chromium], native, { cdp: page }), { x: 900, y: 700 })).target,
    ).toEqual(link);
  });
});

describe("focusedTarget", () => {
  const dialog = win(1, "Gimp", 2, 222, 1188, 734);

  it("reports the focused element of the active window", async () => {
    const native = fakeNative({
      focused: () => ({
        element: el("text", "", { x: 380, y: 355, w: 161, h: 28 }, { editable: true }),
      }),
    });
    const focus = await focusedTarget(deps([dialog], native));
    // origin (2,222): device = (2,222) + ((380,355) − (1,111)) × 2 = (760,710), size 322×56.
    expect(focus).toMatchObject({
      window: 1,
      windowFrame: { x: 1, y: 198, w: 1190, h: 759 },
      target: {
        role: "text",
        editable: true,
        bbox: { x: 760, y: 710, w: 322, h: 56 },
        point: { x: 921, y: 738 },
      },
    });
    expect(focus.unknown).toBeUndefined();
  });

  it("keeps no focused element and an unfinished lookup apart", async () => {
    const none = await focusedTarget(deps([dialog], fakeNative({})));
    expect(none).toMatchObject({ target: null, window: 1 });
    expect(none.unknown).toBeUndefined();
    const late = await focusedTarget(
      deps([dialog], fakeNative({ focused: () => ({ unknown: true }) })),
    );
    expect(late).toMatchObject({ target: null, window: 1, unknown: true });
  });
});

describe("the lookup budget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const never = <T>() => new Promise<T>(() => {});
  const chromium = win(1, "Chromium", 0, 54, 2560, 1414, { frame: [0, 54, 2560, 1414] });
  const reload = el("button", "Reload", { x: 78, y: 73, w: 34, h: 34 }, { space: "chrome" });
  const unknownWindow = {
    window: 1,
    windowFrame: { x: 0, y: 54, w: 2560, h: 1414 },
    unknown: true,
  };
  // A part of the lookup that never answers: the whole lookup still answers within the budget.
  async function past<T>(lookup: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const answer = lookup();
    await vi.advanceTimersByTimeAsync(LOOKUP_BUDGET_MS);
    return answer;
  }

  it("answers unknown with the window when CDP misses it on a hit test", async () => {
    const native = fakeNative({ at: () => ({ element: reload }) });
    const silentPage = { hitTest: never, deviceScaleFactor: async () => 2 };
    const silentScale = { hitTest: async () => null, deviceScaleFactor: never };
    for (const cdp of [silentPage, silentScale]) {
      const d = deps([chromium], native, { cdp: cdp as unknown as ChromiumPerception });
      const hit = await past(() => hitTest(d, { x: 189, y: 179 }));
      expect(hit).toMatchObject({ ...unknownWindow, target: { source: "coords" } });
    }
  });

  it("answers unknown with the window when the helper misses it", async () => {
    const native = fakeNative({ at: never, focused: never });
    const hit = await past(() => hitTest(deps([IMAGE], native), { x: 40, y: 250 }));
    expect(hit).toMatchObject({ window: 11, unknown: true, target: { source: "coords" } });
    const focus = await past(() => focusedTarget(deps([chromium], native)));
    expect(focus).toMatchObject({ ...unknownWindow, target: null });
  });

  it("answers unknown focus with the window when CDP misses it", async () => {
    const native = fakeNative({ focused: () => ({ element: reload }) });
    const cdp = { focused: never, deviceScaleFactor: async () => 2 };
    const d = deps([chromium], native, { cdp: cdp as unknown as ChromiumPerception });
    expect(await past(() => focusedTarget(d))).toMatchObject({ ...unknownWindow, target: null });
    expect(native.asked).toEqual([]);
  });
});

describe("findTarget", () => {
  it("finds an element by role and name in the top-most matching window", async () => {
    const calc = win(4, "libreoffice-calc", 0, 110, 2560, 1358);
    const native = fakeNative({
      tree: () => ({
        elements: [
          el("frame", "Calc", { x: 0, y: 27, w: 1280, h: 707 }),
          el("text", "Name Box", { x: 4, y: 161, w: 119, h: 26 }, { editable: true }),
        ],
      }),
    });
    const d = deps([calc], native);
    const found = await findTarget(d, { name: "name box" });
    expect(found.target).toMatchObject({
      role: "text",
      name: "Name Box",
      bbox: { x: 8, y: 322, w: 238, h: 52 },
      point: { x: 127, y: 348 },
    });
    // The tree is asked for with the screen's change generation, which keys its cache.
    expect(native.asked[0]).toMatchObject({ cmd: "tree", win: 4, generation: 41 });
    expect((await findTarget(d, { name: "Nope", role: "button" })).target).toBeNull();
  });

  it("never looks in the panel, the dock or the desktop window", async () => {
    const native = fakeNative({
      tree: (w) =>
        w.id === 9
          ? { elements: [el("push button", "Search", { x: 10, y: 5, w: 30, h: 20 })] }
          : { elements: [] },
    });
    const panel = win(9, "Xfce4-panel", 0, 0, 2560, 54);
    const d = deps([panel, win(4, "Thunar", 1, 78, 1280, 960)], native);
    expect((await findTarget(d, { name: "Search" })).target).toBeNull();
    expect(native.asked.map((a) => a.win)).toEqual([4]);
  });
});

describe("elements", () => {
  const chromium = win(4, "Chromium", 0, 54, 2560, 1414, { frame: [0, 54, 2560, 1414] });
  const dialog = win(1, "Org.xfce.mousepad", 180, 376, 926, 526, { title: "Find and Replace" });
  const pageElement = (name: string, node: number, y = 700): WireElement => ({
    point: { x: 900, y },
    bbox: { x: 800, y: y - 20, w: 200, h: 40 },
    source: "dom",
    role: "button",
    name,
    node,
  });
  const page = (elements: WireElement[], over: Record<string, unknown> = {}) =>
    ({
      elements: async () => ({
        url: "file:///config/eval/form.html",
        origin: { x: 0, y: 228 },
        elements,
        truncated: false,
      }),
      deviceScaleFactor: async () => 2,
      ...over,
    }) as unknown as ChromiumPerception;

  it("finds controls by part of their names, whole names first, top window first", async () => {
    const native = fakeNative({
      tree: (w) =>
        w.id === 1
          ? {
              elements: [
                el("label", "Replace with:", { x: 102, y: 230, w: 108, h: 26 }),
                el("push button", "Replace", { x: 347, y: 412, w: 94, h: 27 }),
                el("check box", "Replace all in:", { x: 102, y: 374, w: 110, h: 26 }),
                el("push button", "Close", { x: 447, y: 412, w: 94, h: 27 }),
              ],
            }
          : { elements: [el("menu", "Unreplaceable", { x: 1, y: 1, w: 10, h: 10 })] },
    });
    const d = deps([dialog, win(2, "Org.xfce.mousepad", 2, 104, 1280, 960)], native);
    const found = await findElements(d, { text: "replace", limit: 10 });
    expect(found.elements.map((e) => e.name)).toEqual([
      "Replace",
      "Replace with:",
      "Replace all in:",
      "Unreplaceable",
    ]);
    expect(found.elements[0]).toMatchObject({ role: "push button", window: "Find and Replace" });
    const buttons = await findElements(d, { text: "replace", role: "button", limit: 10 });
    expect(buttons.elements.map((e) => e.name)).toEqual(["Replace"]);
    expect((await findElements(d, { text: "replace", limit: 1 })).truncated).toBe(true);
  });

  it("takes a Chromium page's elements from CDP and only the browser's own controls from its tree", async () => {
    const native = fakeNative({
      tree: () => ({
        elements: [
          el("push button", "Reload", { x: 78, y: 73, w: 34, h: 34 }, { space: "chrome" }),
          // The tree's copy of a page element, in other units: it would land in the wrong place.
          el("push button", "Submit page", { x: 400, y: 350, w: 100, h: 20 }, { space: "chrome" }),
        ],
      }),
    });
    const d = deps([chromium], native, { cdp: page([pageElement("Submit page", 90)]) });
    const found = await findElements(d, { text: "e", limit: 10 });
    expect(found.elements.map((e) => [e.name, e.node])).toEqual([
      ["Submit page", 90],
      ["Reload", undefined],
    ]);
    const blind = deps([chromium], native, {
      cdp: page([], { elements: async () => Promise.reject(new Error("no page")) }),
    });
    expect((await findElements(blind, { text: "e", limit: 10 })).elements).toEqual([]);
  });

  it("lists the front Chromium page's elements with its address", async () => {
    const d = deps([dialog, chromium], undefined, {
      cdp: page([pageElement("Submit", 90), pageElement("Search", 91, 300)]),
    });
    expect(await pageElements(d, { page: true, limit: 10 })).toMatchObject({
      url: "file:///config/eval/form.html",
      elements: [{ node: 90 }, { node: 91 }],
      truncated: false,
    });
    expect(await pageElements(deps([dialog]), { page: true })).toEqual({
      elements: [],
      truncated: false,
    });
  });

  it("finds a page element by its node only while it keeps its listed role, name and page", async () => {
    const submit: Target = {
      point: { x: 560, y: 1266 },
      bbox: { x: 400, y: 1226, w: 320, h: 80 },
      source: "dom",
      role: "button",
      name: "Submit",
      url: "file:///config/eval/form.html",
    };
    const nodes: number[] = [];
    const cdp = {
      node: async (_w: HelperWindow, node: number) => {
        nodes.push(node);
        return node === 90 ? submit : null;
      },
    } as unknown as ChromiumPerception;
    const d = deps([dialog, chromium], undefined, { cdp });
    expect((await findTarget(d, { node: 90, role: "button", name: "Submit" })).target).toEqual(
      submit,
    );
    expect((await findTarget(d, { node: 90, role: "button", name: "Send" })).target).toBeNull();
    expect((await findTarget(d, { node: 91, role: "button", name: "Submit" })).target).toBeNull();
    const elsewhere = { node: 90, role: "button", name: "Submit", url: "https://shop.example/" };
    expect((await findTarget(d, elsewhere)).target).toBeNull();
    expect(nodes).toEqual([90, 90, 91, 90]);
  });
});
