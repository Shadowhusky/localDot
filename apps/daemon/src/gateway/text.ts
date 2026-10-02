import { clipText, keyDisplayName, type Point, type Target } from "@localdot/protocol";

const LABEL_MAX = 80;

export function clickLabel(target: Target | null, point: Point, verb = "Click"): string {
  const name = target?.name;
  return clipText(name ? `${verb} "${name}"` : `${verb} at (${point.x}, ${point.y})`, LABEL_MAX);
}

export function typeLabel(text: string, masked: boolean): string {
  const n = [...text].length;
  return masked
    ? `Type ${n} character${n === 1 ? "" : "s"}`
    : clipText(`Type "${text}"`, LABEL_MAX);
}

export function keyLabel(combo: string[]): string {
  return clipText(`Press ${combo.map(keyDisplayName).join("+")}`, LABEL_MAX);
}

export function scrollLabel(dx: number, dy: number): string {
  const parts = [];
  if (dy) parts.push(`${dy > 0 ? "down" : "up"} ${Math.abs(dy)}`);
  if (dx) parts.push(`${dx > 0 ? "right" : "left"} ${Math.abs(dx)}`);
  return `Scroll ${parts.join(", ") || "0"}`;
}

export function clipTarget(t: Target): Target {
  return {
    ...t,
    ...(t.role !== undefined ? { role: clipText(t.role, 64) } : {}),
    ...(t.name !== undefined ? { name: clipText(t.name, 64) } : {}),
    ...(t.app !== undefined ? { app: clipText(t.app, 128) } : {}),
    ...(t.window !== undefined ? { window: clipText(t.window, 256) } : {}),
    ...(t.url !== undefined ? { url: clipText(t.url, 2048) } : {}),
  };
}
