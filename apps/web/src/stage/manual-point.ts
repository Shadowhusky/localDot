import type { Point } from "@localdot/protocol";
import { cameraFor, toWorld } from "@localdot/stage";

// Same zoom-one camera and backing-store viewport as the render worker. Reject letterboxing
// before rounding so an off-desktop click can never be clamped onto a desktop control; a pointer
// already pressed on the desktop (`clamp`) follows its edge instead.
export function manualPoint(
  rect: { left: number; top: number; width: number; height: number },
  screen: { w: number; h: number },
  point: Point,
  backing: { w: number; h: number },
  clamp = false,
): Point | null {
  if (
    ![rect.left, rect.top, point.x, point.y].every(Number.isFinite) ||
    ![rect.width, rect.height, screen.w, screen.h, backing.w, backing.h].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return null;
  if (
    !clamp &&
    (point.x < rect.left ||
      point.y < rect.top ||
      point.x >= rect.left + rect.width ||
      point.y >= rect.top + rect.height)
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
  if (!clamp && (world.x < 0 || world.y < 0 || world.x >= screen.w || world.y >= screen.h))
    return null;
  return {
    x: Math.max(0, Math.min(screen.w - 1, Math.floor(world.x))),
    y: Math.max(0, Math.min(screen.h - 1, Math.floor(world.y))),
  };
}
