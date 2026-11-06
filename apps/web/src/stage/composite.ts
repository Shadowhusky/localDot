import { MODEL_SCREEN, type Point, type ScreenName } from "@localdot/protocol";
import { type Camera, cameraFor } from "@localdot/stage";
import { worldPoint } from "./manual-point.ts";

// The browser keeps a container of its own, with its sign-ins; the stage draws its picture as a
// window on the desktop's, so both read as one screen. Nothing here reaches the computer or dot: their
// screenshots and coordinates are each screen's own.

// The desktop's menu bar stays in view over the browser, at this height before the screen's scale
// (cells/desktop/root/defaults/localdot/xfce4-panel.xml).
export const MENU_BAR_PX = 24;
// A strip of the desktop this thin on the stage, in CSS px, can't be aimed at: it takes no input.
export const MIN_TARGET_PX = 16;
// A margin beside the window this thin, in CSS px, is the window's edge to a finger: it takes nothing.
export const MIN_EDGE_PX = 8;

export interface StageScreen {
  w: number;
  h: number;
}

// The browser's screen on the desktop's, in the desktop's pixels. Its whole picture fits under the
// menu bar at one scale, so its pixels keep their shape and the desktop shows in a slim margin each
// side, where a click lands on nothing.
export interface BrowserWindow {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export function browserWindow(desktop: StageScreen): BrowserWindow {
  const y = Math.round((MENU_BAR_PX * desktop.w) / MODEL_SCREEN.width);
  const scale = (desktop.h - y) / desktop.h;
  const w = desktop.w * scale;
  return { x: (desktop.w - w) / 2, y, w, h: desktop.h - y, scale };
}

// The camera a browser picture draws under, given the desktop's.
export function browserCamera(desktop: Camera, window: BrowserWindow): Camera {
  return {
    scale: desktop.scale * window.scale,
    tx: desktop.tx + window.x * desktop.scale,
    ty: desktop.ty + window.y * desktop.scale,
  };
}

// The same point, given in the desktop's pixels, from the browser's.
export function desktopPoint(point: Point, window: BrowserWindow): Point {
  return { x: window.x + point.x * window.scale, y: window.y + point.y * window.scale };
}

// `behind`: the press is on the desktop behind the browser's window, which it only brings forward,
// as a click on a window behind does; the desktop gets none of it.
export type StagePoint = Point & { screen: ScreenName; behind?: true };

// Which screen a page point falls on, and where. With the browser in front that is the browser, or
// the menu bar above it; a margin beside it is the desktop behind. A pointer already pressed
// (`within`) stays on its own screen, at that screen's edge: a press never carries across.
export function stagePoint(
  rect: { left: number; top: number; width: number; height: number },
  desktop: StageScreen,
  point: Point,
  backing: StageScreen,
  front: ScreenName,
  within?: StagePoint | null,
): StagePoint | null {
  const pressed = within?.screen;
  const world = worldPoint(rect, desktop, point, backing, !!within);
  if (!world) return null;
  const whole = (at: Point, screen: ScreenName): StagePoint => ({
    x: Math.max(0, Math.min(desktop.w - 1, Math.floor(at.x))),
    y: Math.max(0, Math.min(desktop.h - 1, Math.floor(at.y))),
    screen,
  });
  if (within?.behind) return { ...whole(world, "desktop"), behind: true };
  if (pressed === "desktop" || (front === "desktop" && pressed !== "browser"))
    return whole(world, "desktop");
  const window = browserWindow(desktop);
  const inside = {
    x: (world.x - window.x) / window.scale,
    y: (world.y - window.y) / window.scale,
  };
  if (
    pressed === "browser" ||
    (inside.x >= 0 && inside.y >= 0 && inside.x < desktop.w && inside.y < desktop.h)
  )
    return whole(inside, "browser");
  const camera = cameraFor({
    stageW: backing.w,
    stageH: backing.h,
    desktopW: desktop.w,
    desktopH: desktop.h,
    zoom: 1,
  });
  if (world.y >= window.y) {
    const margin = (window.x * camera.scale * rect.width) / backing.w;
    return margin >= MIN_EDGE_PX ? { ...whole(world, "desktop"), behind: true } : null;
  }
  const bar = (window.y * camera.scale * rect.height) / backing.h;
  return bar >= MIN_TARGET_PX ? whole(world, "desktop") : null;
}
