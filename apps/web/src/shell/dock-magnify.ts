// The collapsed rail magnifies its marks under the pointer the way the macOS Dock does. The mark
// under it grows most and its neighbours less, along a raised cosine that comes to nothing
// REACH_ROWS marks away. The rail stretches by the growth between any two points, so marks part
// along it and never overlap. Each grows away from the screen's edge.
export const MAX_SCALE = 1.75;
export const REACH_ROWS = 3.5;
// The names beside the marks fade out over this many marks from the one under the pointer.
export const NAME_ROWS = 2.5;

export interface Span {
  top: number;
  bottom: number;
}

// 1 under the pointer, easing to 0 at `reach`, flat at both ends so no mark jumps as it enters.
export function falloff(distance: number, reach: number): number {
  const x = Math.abs(distance) / reach;
  return x >= 1 ? 0 : (1 + Math.cos(Math.PI * x)) / 2;
}

// The falloff summed from the pointer to `distance`, signed: the room the growth between takes.
export function spread(distance: number, reach: number): number {
  const x = Math.max(-reach, Math.min(reach, distance));
  return (x + (reach / Math.PI) * Math.sin((Math.PI * x) / reach)) / 2;
}

export interface Lens {
  // The place on the rail at rest that lies under the pointer: the mark there is the one it is on.
  focus: number;
  // Each span's scale about its middle, and how far that middle moves.
  spans: { scale: number; offset: number }[];
  // How far any other point on the rail moves.
  move(y: number): number;
}

// The rail under a pointer at `pointer`, `amount` of the way in (0 to 1). Marks wholly in `view`
// stay in it while the rail has room, the rail sliding into the room it has. When it hasn't, the
// end nearer the pointer stays and the far end gives; halfway, both give evenly. A slide moves the
// mark under the pointer too, so the focus is found where the mark it magnifies most lands under it.
export function lens(
  spans: readonly Span[],
  pointer: number,
  amount: number,
  view: Span,
  reach: number,
  maxScale = MAX_SCALE,
): Lens {
  const gain = amount * (maxScale - 1);
  const kept = spans.filter((span) => span.top >= view.top && span.bottom <= view.bottom);
  const first = kept[0]?.top ?? view.top;
  const last = kept.at(-1)?.bottom ?? view.bottom;
  // Near an end (half the reach, or less on a short rail), that end stays whole. Between, the cut
  // moves from one end to the other over a stretch as long as all the growth, so the slide never
  // falls back as fast as the focus moves on.
  const turn = gain * reach;
  const hold = Math.min(reach / 2, Math.max(0, (last - first - turn) / 2));
  const blend = Math.max(last - first - 2 * hold, turn);
  const shape = (focus: number) => {
    const at = (y: number) => y + gain * spread(y - focus, reach);
    const low = view.top - at(first);
    const high = view.bottom - at(last);
    const top = Math.min(1, Math.max(0, (last - hold - focus) / blend));
    const slide = low <= high ? Math.min(Math.max(0, low), high) : top * low + (1 - top) * high;
    return { at, slide: kept.length ? slide : 0 };
  };
  // So where the focus lands always moves on with it, and the one under the pointer is found by
  // halving.
  let low = pointer - gain * reach - 1;
  let high = pointer + gain * reach + 1;
  for (let n = 0; gain > 0 && n < 24; n++) {
    const middle = (low + high) / 2;
    if (middle + shape(middle).slide < pointer) low = middle;
    else high = middle;
  }
  const focus = gain > 0 ? (low + high) / 2 : pointer;
  const { at, slide } = shape(focus);
  return {
    focus,
    spans: spans.map((span) => {
      const top = at(span.top);
      const bottom = at(span.bottom);
      return {
        scale: (bottom - top) / (span.bottom - span.top || 1),
        offset: (top + bottom - span.top - span.bottom) / 2 + slide,
      };
    }),
    move: (y) => at(y) - y + slide,
  };
}

// How much of the name beside `span` shows: all of it while the focus is on the span, fading out
// over `reach` from its edges.
export function nameOpacity(span: Span, focus: number, reach: number): number {
  const away = Math.max(0, span.top - focus, focus - span.bottom) / reach;
  return away >= 1 ? 0 : (1 - away) ** 2;
}
