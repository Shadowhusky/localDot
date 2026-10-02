export type CoordSpace = { kind: "pixels"; width: number; height: number } | { kind: "per1000" };

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

const isPositive = (value: number) => Number.isFinite(value) && value > 0;
const isPositiveInteger = (value: number) => Number.isInteger(value) && value > 0;

function assertValid(screen: Screen, space?: CoordSpace): void {
  if (!isPositiveInteger(screen.width) || !isPositiveInteger(screen.height)) {
    throw new RangeError(
      `screen size must be positive integers, got ${screen.width}x${screen.height}`,
    );
  }
  if (!isPositive(screen.scale)) {
    throw new RangeError(`screen scale must be positive, got ${screen.scale}`);
  }
  if (space && space.kind !== "per1000" && !(isPositive(space.width) && isPositive(space.height))) {
    throw new RangeError(`${space.kind} size must be positive, got ${space.width}x${space.height}`);
  }
}

export function toScreen(x: number, y: number, space: CoordSpace, screen: Screen): ScreenPoint {
  assertValid(screen, space);
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
  assertValid(screen);
  const nx = point.x / screen.width;
  const ny = point.y / screen.height;
  if (space.kind === "per1000") return { x: Math.round(nx * 1000), y: Math.round(ny * 1000) };
  return { x: Math.round(nx * space.width), y: Math.round(ny * space.height) };
}

export function toDevice(point: ScreenPoint, screen: Screen): ScreenPoint {
  assertValid(screen);
  return { x: Math.round(point.x * screen.scale), y: Math.round(point.y * screen.scale) };
}
