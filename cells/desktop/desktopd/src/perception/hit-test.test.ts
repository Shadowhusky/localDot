import { describe, expect, it } from "vitest";
import type { XHelper } from "../x/helper.ts";
import type { CuaDriver, DriverElement } from "./driver.ts";
import { findTarget, hitTest, type PerceptionDeps } from "./hit-test.ts";

const win = (
  id: number,
  cls: string,
  x: number,
  y: number,
  w: number,
  h: number,
  pid = 10 * id,
) => ({
  id,
  pid,
  cls,
  title: `${cls} window`,
  x,
  y,
  w,
  h,
  frame: [x - 1, y - 24, w + 2, h + 25] as [number, number, number, number],
  active: id === 1,
  overrideRedirect: false,
  transientFor: null as number | null,
});

function deps(
  windows: ReturnType<typeof win>[],
  trees: Record<number, DriverElement[]>,
  scale: 1 | 2 = 2,
): PerceptionDeps & { driverCalls: number[] } {
  const driverCalls: number[] = [];
  const x = {
    call: async (cmd: string) => (cmd === "windows" ? { windows, generation: 1 } : {}),
  } as unknown as XHelper;
  const driver = {
    windowState: async (_pid: number, id: number) => {
      driverCalls.push(id);
      return { elements: trees[id] ?? [] };
    },
  } as unknown as CuaDriver;
  return { x, driver, scale, readScaling: async () => scale, driverCalls };
}

const el = (
  index: number,
  role: string,
  label: string,
  frame: DriverElement["frame"],
  depth: number,
  parent?: number,
  inWeb = false,
): DriverElement => ({
  element_index: index,
  role,
  label,
  frame,
  depth,
  parent_index: parent,
  in_web_content: inWeb,
});

describe("hitTest", () => {
  it("picks the top-most window under the point and the smallest mapped element containing it", async () => {
    // The helper lists windows top-most first: the terminal (active, on top) overlaps Thunar.
    const d = deps(
      [win(1, "Xfce4-terminal", 500, 300, 800, 600), win(2, "Thunar", 1, 78, 1280, 960)],
      {
        2: [
          el(0, "frame", "Thunar window", { x: 0, y: 0, w: 640, h: 480 }, 0),
          el(1, "menu bar", "", { x: 0, y: 39, w: 640, h: 27 }, 1, 0),
          el(2, "menu", "File", { x: 0, y: 39, w: 39, h: 27 }, 2, 1),
        ],
        1: [el(0, "frame", "Terminal", { x: 250, y: 150, w: 400, h: 300 }, 0)],
      },
    );
    // (20,100) is outside the terminal's frame (x ≥ 499), so Thunar is the window under it;
    // the File menu at frame (0,39,39,27) maps to device (1,78,78,54) with origin (1,78), g = 2.
    const hit = await hitTest(d, { x: 20, y: 100 });
    expect(hit.window).toBe(2);
    expect(hit.target).toMatchObject({
      point: { x: 20, y: 100 },
      source: "ax",
      role: "menu",
      name: "File",
      app: "Thunar",
      window: "Thunar window",
      bbox: { x: 1, y: 78, w: 78, h: 54 },
    });
    expect(d.driverCalls).toEqual([2]);
    // (600,400) is inside both; the top-most (terminal) wins.
    const inTerminal = await hitTest(d, { x: 600, y: 400 });
    expect(inTerminal.window).toBe(1);
    expect(inTerminal.target?.app).toBe("Xfce4-terminal");
  });

  it("names an open menu over its parent window as the window under the point", async () => {
    const menu = {
      ...win(30, "Gimp", -10, 150, 640, 1108),
      frame: [-10, 150, 640, 1108] as [number, number, number, number],
      overrideRedirect: true,
      transientFor: 2,
    };
    const d = deps([menu, win(2, "Gimp", 2, 110, 1600, 1200)], { 30: [], 2: [] });
    const hit = await hitTest(d, { x: 115, y: 296 });
    expect(hit.window).toBe(30);
    expect(d.driverCalls).toEqual([30]);
  });

  it("returns a coordinates-only target on a window's decoration and nothing on empty desktop", async () => {
    const d = deps([win(2, "Thunar", 1, 78, 1280, 960)], { 2: [] });
    const title = await hitTest(d, { x: 100, y: 60 });
    expect(title.target).toMatchObject({ source: "coords", app: "Thunar" });
    expect(title.target?.bbox).toBeUndefined();
    const nothing = await hitTest(d, { x: 2500, y: 1500 });
    expect(nothing.target).toBeNull();
    expect(nothing.window).toBeNull();
  });

  it("never names the panel, the dock or the desktop as the window under a point", async () => {
    const d = deps([win(9, "Xfce4-panel", 0, 0, 2560, 54), win(2, "Thunar", 1, 78, 1280, 960)], {
      2: [],
      9: [],
    });
    const onPanel = await hitTest(d, { x: 100, y: 20 });
    expect(onPanel.target).toBeNull();
    expect(onPanel.window).toBeNull();
    expect(d.driverCalls).toEqual([]);
  });

  it("flags password fields as secret and clips long names", async () => {
    const d = deps([win(3, "Mousepad", 0, 54, 1000, 800)], {
      3: [el(0, "password text", "x".repeat(200), { x: 10, y: 40, w: 100, h: 20 }, 1)],
    });
    // GTK3 with origin (0,54), g = 2: device = (0,54) + ((10,40) − (0,27)) × 2 = (20,80), size 200×40.
    const hit = await hitTest(d, { x: 50, y: 90 });
    expect(hit.target?.bbox).toEqual({ x: 20, y: 80, w: 200, h: 40 });
    expect(hit.target?.secret).toBe(true);
    expect(hit.target?.name?.length).toBe(64);
    expect(hit.target?.name?.endsWith("…")).toBe(true);
  });

  it("applies the VCL shift inside LibreOffice tool bars", async () => {
    const d = deps([win(4, "libreoffice-calc", 0, 77, 2560, 1523)], {
      4: [
        el(0, "frame", "Calc", { x: 0, y: 38, w: 1280, h: 762 }, 0),
        el(1, "menu", "File", { x: 0, y: 38, w: 39, h: 27 }, 1, 0),
        el(2, "tool bar", "Standard", { x: 0, y: 40, w: 1280, h: 36 }, 1, 0),
        el(3, "button", "New", { x: 4, y: 40, w: 45, h: 36 }, 2, 2),
      ],
    });
    const hit = await hitTest(d, { x: 40, y: 150 });
    expect(hit.target).toMatchObject({
      role: "button",
      name: "New",
      bbox: { x: 8, y: 134, w: 90, h: 72 },
    });
  });
});

describe("findTarget", () => {
  it("finds an element by role and name in the top-most matching window", async () => {
    const d = deps([win(4, "libreoffice-calc", 0, 77, 2560, 1523)], {
      4: [
        el(0, "frame", "Calc", { x: 0, y: 38, w: 1280, h: 762 }, 0),
        el(1, "text", "Name Box", { x: 10, y: 80, w: 100, h: 24 }, 2, 0),
      ],
    });
    const found = await findTarget(d, { name: "name box" });
    expect(found.target).toMatchObject({
      role: "text",
      name: "Name Box",
      bbox: { x: 20, y: 161, w: 200, h: 48 },
    });
    expect(found.target?.point).toEqual({ x: 120, y: 185 });
    expect((await findTarget(d, { name: "Nope", role: "button" })).target).toBeNull();
  });

  it("never looks in the panel, the dock or the desktop window", async () => {
    const d = deps([win(9, "Xfce4-panel", 0, 0, 2560, 54), win(4, "Thunar", 1, 78, 1280, 960)], {
      9: [el(0, "push button", "Search", { x: 10, y: 5, w: 30, h: 20 }, 1)],
      4: [],
    });
    expect((await findTarget(d, { name: "Search" })).target).toBeNull();
    expect(d.driverCalls).toEqual([4]);
  });
});
