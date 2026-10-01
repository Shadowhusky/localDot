export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placement {
  x: number;
  y: number;
  scale: number;
}

// Frames are canvas boxes (y-down art pixels); the skeleton origin sits at `root` on that canvas.
export function fitFrame(
  frame: Frame,
  root: { x: number; y: number },
  width: number,
  height: number,
): Placement | null {
  if (!(width > 0 && height > 0 && frame.w > 0 && frame.h > 0)) return null;
  const scale = Math.min(width / frame.w, height / frame.h);
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  return { scale, x: width / 2 - (cx - root.x) * scale, y: height / 2 - (cy - root.y) * scale };
}

export function frameRect(
  frame: Frame,
  root: { x: number; y: number },
  placement: Placement,
): { x: number; y: number; w: number; h: number } {
  const { x, y, scale } = placement;
  return {
    x: x + (frame.x - root.x) * scale,
    y: y + (frame.y - root.y) * scale,
    w: frame.w * scale,
    h: frame.h * scale,
  };
}
