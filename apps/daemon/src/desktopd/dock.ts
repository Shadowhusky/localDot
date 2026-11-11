import { type ScreenWindow, ULID_PATTERN } from "@localdot/protocol";
import type { Hono } from "hono";
import type { CellApi } from "../cells/orchestrator.ts";
import type { CellDesktopd } from "./registry.ts";

// The desktop's dock in its own 1280 × 800 measure: Plank's nine pinned apps on their glass
// (cells/desktop's localdot-plank and localdot-glass theme) and the web browser's item the stage
// draws on the same line, 8 px to their right (apps/web's browser-window.css).
export const DOCK_AREA = { x: 387, y: 732, w: 587, h: 68 };
const MEASURE = { w: 1280, h: 800 };

// One reading serves every viewer of the computer this long; a viewer asks about once a second.
const KEPT_MS = 700;
const READ_MS = 1500;

type Frame = ScreenWindow["frame"];

// Whether an application window lies over the dock, as Plank's window-dodge has it, from the
// window stack top first. desktopd names no window's kind, so the desktop's own furniture is told by
// its place: the desktop is the whole screen at the bottom of the stack, the dock's window a strip
// the screen's width along its foot, and the menu bar one along its head never reaches the dock.
// A minimised window keeps its place in the stack, so it still counts.
export function dockCovered(
  windows: readonly { frame: Frame }[],
  screen: { w: number; h: number },
): boolean {
  const unit = screen.w / MEASURE.w;
  const area = {
    x: DOCK_AREA.x * unit,
    y: DOCK_AREA.y * unit,
    w: DOCK_AREA.w * unit,
    h: DOCK_AREA.h * unit,
  };
  return windows.some(({ frame: f }, index) => {
    const wide = f.x <= 0 && f.x + f.w >= screen.w;
    const foot = f.y + f.h >= screen.h;
    if (wide && foot && f.y <= 0 && index === windows.length - 1) return false;
    if (wide && foot && f.h < screen.h / 4) return false;
    return (
      f.x < area.x + area.w && f.x + f.w > area.x && f.y < area.y + area.h && f.y + f.h > area.y
    );
  });
}

export interface DockRoutesDeps {
  cells: Pick<CellApi, "get">;
  registry: { for(cellId: string): Pick<CellDesktopd, "client"> | undefined };
  // Whether the computer's web browser has a window: the stage's item stands in the dock only then.
  browserRunning?(cellId: string): boolean | Promise<boolean>;
  now?(): number;
}

// Whether the computer's dock is covered and its web browser running, for the stage's own item in
// it: a yes or no each, and nothing of what the windows are.
export function dockRoutes(app: Hono, deps: DockRoutesDeps): void {
  const now = deps.now ?? Date.now;
  const kept = new Map<
    string,
    { at: number; covered: Promise<boolean>; browser: Promise<boolean> }
  >();
  app.get("/api/cells/:id/dock", async (c) => {
    const id = c.req.param("id");
    if (!ULID_PATTERN.test(id)) return c.text("invalid computer id", 400);
    const cell = deps.cells.get(id);
    if (cell?.state !== "ready" || cell.paused || cell.fenced || cell.replacementPending)
      return c.text("the computer is unavailable", 409);
    const desktopd = deps.registry.for(id);
    if (!desktopd) return c.text("the computer is not connected", 503);
    let reading = kept.get(id);
    if (!reading || now() - reading.at > KEPT_MS) {
      const screen = { w: MEASURE.w * cell.scale, h: MEASURE.h * cell.scale };
      const read = {
        at: now(),
        covered: desktopd.client
          .windows({}, AbortSignal.timeout(READ_MS))
          .then((stack) => dockCovered(stack.windows, screen)),
        // Unknown counts as running: the item then behaves as it always has.
        browser: Promise.resolve(deps.browserRunning?.(id) ?? true).catch(() => true),
      };
      read.covered.catch(() => {
        if (kept.get(id) === read) kept.delete(id);
      });
      kept.set(id, read);
      reading = read;
    }
    try {
      return c.json({ covered: await reading.covered, browser: await reading.browser }, 200, {
        "cache-control": "no-store",
      });
    } catch {
      return c.text("the computer's windows can't be read", 502);
    }
  });
}
