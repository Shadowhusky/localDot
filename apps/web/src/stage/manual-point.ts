import type { Point } from "@localdot/protocol";
import { cameraFor, toWorld } from "@localdot/stage";

// Same zoom-one camera and backing-store viewport as the render worker. Reject letterboxing
// before rounding so an off-desktop click can never be clamped onto a desktop control.
export function manualPoint(
  rect: { left: number; top: number; width: number; height: number },
  screen: { w: number; h: number },
  point: Point,
  backing: { w: number; h: number },
): Point | null {
  if (
    ![rect.left, rect.top, point.x, point.y].every(Number.isFinite) ||
    ![rect.width, rect.height, screen.w, screen.h, backing.w, backing.h].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null;
  if (
    point.x < rect.left ||
    point.y < rect.top ||
    point.x >= rect.left + rect.width ||
    point.y >= rect.top + rect.height
  )
    return null;
  const camera = cameraFor({
    stageW: backing.w,
    stageH: backing.h,
    desktopW: screen.w,
    desktopH: screen.h,
    zoom: 1,
  });
  const world = toWorld(camera, {
    x: ((point.x - rect.left) * backing.w) / rect.width,
    y: ((point.y - rect.top) * backing.h) / rect.height,
  });
  if (world.x < 0 || world.y < 0 || world.x >= screen.w || world.y >= screen.h) return null;
  return {
    x: Math.min(screen.w - 1, Math.floor(world.x)),
    y: Math.min(screen.h - 1, Math.floor(world.y)),
  };
}
export function manualKey(
  key: string,
  modifiers: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean },
): string[] | null {
  const names: Record<string, string> = {
    Enter: "enter",
    Escape: "esc",
    Backspace: "backspace",
    Delete: "delete",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
  };
  const name =
    names[key] ??
    ((modifiers.ctrlKey || modifiers.altKey || modifiers.metaKey) && /^[a-z0-9]$/i.test(key)
      ? key.toLowerCase()
      : /^F(?:[1-9]|1[0-2])$/.test(key)
        ? key
        : null);
  if (!name) return null; // Text/IME/paste uses the explicit bounded text command. Tab keeps focus navigation.
  return [
    ...(modifiers.ctrlKey ? ["ctrl"] : []),
    ...(modifiers.altKey ? ["alt"] : []),
    ...(modifiers.shiftKey ? ["shift"] : []),
    ...(modifiers.metaKey ? ["super"] : []),
    name,
  ];
}
