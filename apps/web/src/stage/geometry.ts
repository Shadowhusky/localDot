// The macOS arrow of the design-v2 board, tip at the origin, as drawn in its 22 px box.
const ARROW = [0, 0, 0, 15.6, 4.2, 11.5, 7.1, 18.1, 9.8, 16.9, 7, 10.4, 12.9, 10.4];
export const ARROW_BOX_PX = 22;
// The name chip needs room beside the cursor; on a small stage the cursor goes without it.
export const CHIP_MIN_STAGE_PX = 600;

export function cursorPolygon(): number[] {
  return [...ARROW];
}

// The cursor's box height on a stage this many CSS px wide (design-v2 §12).
export function cursorSizePx(stageWidth: number): number {
  if (stageWidth >= 800) return 22;
  if (stageWidth >= 600) return 18;
  return 16;
}

// A focus ring's corner on the element's box padded 3, as the board draws it: 9 px, or half its
// height on a small element.
export function targetRadius(height: number): number {
  return Math.min(9, (height + 6) / 2);
}

export function videoPlacement(
  frame: { w: number; h: number },
  screen: { w: number; h: number },
): { sx: number; sy: number; mismatch: boolean } {
  const sx = screen.w / frame.w;
  const sy = screen.h / frame.h;
  return { sx, sy, mismatch: sx !== 1 || sy !== 1 };
}
