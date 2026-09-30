export type CoordSpace =
  | { kind: "pixels"; width: number; height: number }
  | { kind: "per1000" }
  | { kind: "resizedPixels"; width: number; height: number };

export interface Screen {
  width: number;
  height: number;
  scale: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalized = (x: number, y: number, space: CoordSpace) =>
  space.kind === "per1000"
    ? { nx: x / 1000, ny: y / 1000 }
    : { nx: x / space.width, ny: y / space.height };

export function toScreen(x: number, y: number, space: CoordSpace, screen: Screen): ScreenPoint {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError(`non-finite model coordinate (${x}, ${y})`);
  }
  const { nx, ny } = normalized(x, y, space);
  return {
    x: clamp(Math.round(nx * screen.width), 0, screen.width - 1),
    y: clamp(Math.round(ny * screen.height), 0, screen.height - 1),
  };
}

export function toModel(point: ScreenPoint, space: CoordSpace, screen: Screen): ScreenPoint {
  const nx = point.x / screen.width;
  const ny = point.y / screen.height;
  if (space.kind === "per1000") return { x: Math.round(nx * 1000), y: Math.round(ny * 1000) };
  return { x: Math.round(nx * space.width), y: Math.round(ny * space.height) };
}

export function toDevice(point: ScreenPoint, screen: Screen): ScreenPoint {
  return { x: Math.round(point.x * screen.scale), y: Math.round(point.y * screen.scale) };
}
