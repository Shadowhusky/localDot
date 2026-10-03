import type { CoordSpaceName } from "@localdot/protocol";
import { MODEL_SCREEN } from "@localdot/protocol";

export type ModelPointResult =
  | { ok: true; point: { x: number; y: number } }
  | { ok: false; error: string };

// A model's coordinate, in the space its tool declared, to model pixels (1280×800). Unlike the
// stage's toScreen, which clamps, a coordinate outside the space is refused: clamping would click
// the screen's edge, somewhere the model never pointed (Review Focus 5).
export function modelPoint(
  coordinate: readonly number[] | undefined,
  space: CoordSpaceName,
): ModelPointResult {
  if (coordinate?.length !== 2) return { ok: false, error: "coordinate must be [x, y]" };
  const [x, y] = coordinate as [number, number];
  if (!Number.isFinite(x) || !Number.isFinite(y))
    return { ok: false, error: "coordinate must be finite numbers" };
  const { width, height } = MODEL_SCREEN;
  if (space === "per1000") {
    if (x < 0 || y < 0 || x > 1000 || y > 1000) {
      return { ok: false, error: `coordinate (${x}, ${y}) is outside the 0–1000 grid` };
    }
    return {
      ok: true,
      point: {
        x: Math.min(width - 1, Math.round((x / 1000) * width)),
        y: Math.min(height - 1, Math.round((y / 1000) * height)),
      },
    };
  }
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return { ok: false, error: `coordinate (${x}, ${y}) is outside the ${width}×${height} screen` };
  }
  return {
    ok: true,
    point: { x: Math.min(width - 1, Math.round(x)), y: Math.min(height - 1, Math.round(y)) },
  };
}

// The other way, for the model's own view of where the cursor is (cursor_position).
export function toModelSpace(
  point: { x: number; y: number },
  space: CoordSpaceName,
): [number, number] {
  if (space === "pixels") return [point.x, point.y];
  return [
    Math.round((point.x / MODEL_SCREEN.width) * 1000),
    Math.round((point.y / MODEL_SCREEN.height) * 1000),
  ];
}
