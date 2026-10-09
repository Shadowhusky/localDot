// A picture on its stage: drawn at `scale`, its top-left corner at (x, y) in the stage's pixels.
export interface View {
  scale: number;
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}

export const MAX_SCALE = 8;
// Room kept round a picture shown whole.
const MARGIN = 24;

// The scale that shows the whole picture, never larger than its own pixels.
export function fitScale(picture: Size, stage: Size): number {
  if (!picture.w || !picture.h) return 1;
  return Math.min(1, (stage.w - MARGIN * 2) / picture.w, (stage.h - MARGIN * 2) / picture.h);
}

export function minScale(picture: Size, stage: Size): number {
  return Math.min(fitScale(picture, stage), 1);
}

export function centred(picture: Size, stage: Size, scale: number): View {
  return { scale, x: (stage.w - picture.w * scale) / 2, y: (stage.h - picture.h * scale) / 2 };
}

// Zooms to `scale` keeping the stage point (px, py) over the same spot of the picture.
export function zoomAt(view: View, scale: number, px: number, py: number): View {
  const k = scale / view.scale;
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

// Where the picture may rest: centred along an axis it does not fill, edge to edge along one it does.
export function settle(view: View, picture: Size, stage: Size): View {
  const axis = (at: number, length: number, room: number) =>
    length <= room ? (room - length) / 2 : Math.min(0, Math.max(room - length, at));
  return {
    scale: view.scale,
    x: axis(view.x, picture.w * view.scale, stage.w),
    y: axis(view.y, picture.h * view.scale, stage.h),
  };
}

// Past an edge the picture follows less the further it goes, and springs back on release.
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (dimension <= 0) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

export function dragged(view: View, picture: Size, stage: Size): View {
  const rest = settle(view, picture, stage);
  return {
    scale: view.scale,
    x: rest.x + rubberband(view.x - rest.x, stage.w),
    y: rest.y + rubberband(view.y - rest.y, stage.h),
  };
}

// Whether the picture is larger than its stage, so a drag pans it rather than turning the page.
export function zoomedIn(view: View, picture: Size, stage: Size): boolean {
  return picture.w * view.scale > stage.w + 1 || picture.h * view.scale > stage.h + 1;
}

// Where a flick would carry something (Apple's deceleration, 0.998 per ms).
export function project(velocity: number, rate = 0.998): number {
  return ((velocity / 1000) * rate) / (1 - rate);
}

// A horizontal swipe's outcome: the next file (1), the previous (-1) or staying (0). Judged by where
// the drag would land, so a short fast flick turns the page as a long slow drag does; a flick back
// against the drag only returns it.
export function swipeTurn(dx: number, velocity: number, width: number): -1 | 0 | 1 {
  const landing = dx + project(velocity);
  if (Math.abs(landing) < width * 0.35 || Math.sign(landing) !== Math.sign(dx)) return 0;
  return landing < 0 ? 1 : -1;
}
