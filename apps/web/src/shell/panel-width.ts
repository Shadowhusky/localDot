export interface PanelWidth {
  // Where the width is kept between visits.
  key: string;
  initial: number;
  min: number;
  // A panel that only needs so much says so; any other grows as far as the page has room.
  max?: number;
  // What the rest of the page keeps beside the panel, so the stage never gets squeezed out.
  reserve: number;
}

// The stage's column at its narrowest, 520 px: its picture as wide as the island and the decision
// that grows out of it (480 px), inside the gutters, with the top bar still in one line. Beside it
// the page's inset, and the gap a wide screen puts between the columns.
const STAGE_ROOM = 536;

export const CHAT_WIDTH: PanelWidth = {
  key: "localdot.width.chat",
  initial: 368,
  min: 320,
  reserve: STAGE_ROOM,
};

// The conversations rail, expanded.
export const SESSIONS_WIDTH: PanelWidth = {
  key: "localdot.width.sessions",
  initial: 256,
  min: 208,
  max: 420,
  reserve: STAGE_ROOM,
};

// The conversations rail's room when it shows only its marks.
export const SESSIONS_FOLDED = 56;

export function widthLimits(
  panel: PanelWidth,
  viewport: number,
  beside = 0,
): { min: number; max: number } {
  return {
    min: panel.min,
    max: Math.max(
      panel.min,
      Math.min(panel.max ?? Number.POSITIVE_INFINITY, viewport - panel.reserve - beside),
    ),
  };
}

export const clampWidth = (width: number, { min, max }: { min: number; max: number }) =>
  Math.round(Math.min(max, Math.max(min, width)));

export function readWidth(panel: PanelWidth): number {
  try {
    const saved = Number(localStorage.getItem(panel.key));
    return Number.isFinite(saved) && saved > 0 ? saved : panel.initial;
  } catch {
    return panel.initial;
  }
}

// What a handle holds its panel at now, which a smaller window can keep under what is saved.
const held = new Map<PanelWidth, number>();

export const holdWidth = (panel: PanelWidth, width: number) => held.set(panel, width);
export const releaseWidth = (panel: PanelWidth) => held.delete(panel);
export const shownWidth = (panel: PanelWidth) => held.get(panel) ?? readWidth(panel);

export function saveWidth(panel: PanelWidth, width: number): void {
  try {
    if (width === panel.initial) localStorage.removeItem(panel.key);
    else localStorage.setItem(panel.key, String(width));
  } catch {}
}

// Past a limit the edge keeps following, ever more slowly, toward `reach` px beyond it.
export function rubberBand(overshoot: number, reach = 60, constant = 0.55): number {
  const magnitude = Math.abs(overshoot);
  return (Math.sign(overshoot) * (magnitude * reach * constant)) / (reach + constant * magnitude);
}

// Where the edge sits for a pointer `travel` px outward of where the drag began.
export function dragWidth(start: number, travel: number, limits: { min: number; max: number }) {
  const raw = start + travel;
  if (raw > limits.max) return limits.max + rubberBand(raw - limits.max);
  if (raw < limits.min) return limits.min + rubberBand(raw - limits.min);
  return raw;
}
