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

export function keyLabel(
  combo: string[],
  how: { repeat?: number | undefined; holdMs?: number | undefined } = {},
): string {
  const keys = combo.map(keyDisplayName).join("+");
  if (how.holdMs)
    return clipText(`Hold ${keys} for ${Number((how.holdMs / 1000).toFixed(1))} s`, LABEL_MAX);
  const times = how.repeat && how.repeat > 1 ? ` ${how.repeat} times` : "";
  return clipText(`Press ${keys}${times}`, LABEL_MAX);
}

const at = (target: Target | null | undefined, point: Point) =>
  target?.name ? `"${target.name}"` : `(${point.x}, ${point.y})`;

export function dragLabel(
  from: { target: Target | null | undefined; point: Point },
  to: { target: Target | null | undefined; point: Point },
): string {
  return clipText(`Drag ${at(from.target, from.point)} to ${at(to.target, to.point)}`, LABEL_MAX);
}

export function moveLabel(target: Target | null | undefined, point: Point): string {
  return clipText(`Move to ${at(target, point)}`, LABEL_MAX);
}

export function buttonLabel(
  verb: "down" | "up",
  button: "left" | "right" | "middle",
  target: Target | null | undefined,
  point: Point,
): string {
  const where = target?.name ? ` on "${target.name}"` : ` at (${point.x}, ${point.y})`;
  return clipText(
    `${verb === "down" ? "Hold down" : "Release"} the ${button} button${where}`,
    LABEL_MAX,
  );
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
    ...(t.url !== undefined ? { url: clipText(publicLocation(t.url), 2048) } : {}),
  };
}

function publicLocation(value: string): string {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? `${url.origin}${url.pathname}` : "";
  } catch {
    return "";
  }
}
