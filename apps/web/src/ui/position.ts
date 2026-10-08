export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  side: Side;
  // The room on the chosen side; a taller popup scrolls inside it.
  maxHeight: number;
  // The point of the popup nearest its anchor, where it grows from.
  originX: number;
  originY: number;
}

interface PlaceOptions {
  anchor: Rect;
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  side: Side;
  align: Align;
  gap?: number;
  edge?: number;
}

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function aligned(start: number, length: number, size: number, align: Align): number {
  if (align === "start") return start;
  if (align === "end") return start + length - size;
  return start + length / 2 - size / 2;
}

// Puts a popup beside its anchor on the requested side, or on the opposite side when that has more
// room and the requested one is too small, then slides it along the anchor to stay on screen.
export function place({
  anchor,
  size,
  viewport,
  side,
  align,
  gap = 8,
  edge = 8,
}: PlaceOptions): Placement {
  const room: Record<Side, number> = {
    top: anchor.top - gap - edge,
    bottom: viewport.height - (anchor.top + anchor.height) - gap - edge,
    left: anchor.left - gap - edge,
    right: viewport.width - (anchor.left + anchor.width) - gap - edge,
  };
  const vertical = side === "top" || side === "bottom";
  const needed = vertical ? size.height : size.width;
  const chosen = needed > room[side] && room[OPPOSITE[side]] > room[side] ? OPPOSITE[side] : side;
  const centreX = anchor.left + anchor.width / 2;
  const centreY = anchor.top + anchor.height / 2;

  if (vertical) {
    const maxHeight = Math.max(0, room[chosen]);
    const height = Math.min(size.height, maxHeight);
    const top = chosen === "bottom" ? anchor.top + anchor.height + gap : anchor.top - gap - height;
    const left = clamp(
      aligned(anchor.left, anchor.width, size.width, align),
      edge,
      viewport.width - edge - size.width,
    );
    return {
      top,
      left,
      side: chosen,
      maxHeight,
      originX: clamp(centreX - left, 0, size.width),
      originY: chosen === "bottom" ? 0 : height,
    };
  }

  const maxHeight = Math.max(0, viewport.height - 2 * edge);
  const height = Math.min(size.height, maxHeight);
  const left =
    chosen === "right" ? anchor.left + anchor.width + gap : anchor.left - gap - size.width;
  const top = clamp(
    aligned(anchor.top, anchor.height, height, align),
    edge,
    viewport.height - edge - height,
  );
  return {
    top,
    left,
    side: chosen,
    maxHeight,
    originX: chosen === "right" ? 0 : size.width,
    originY: clamp(centreY - top, 0, height),
  };
}
