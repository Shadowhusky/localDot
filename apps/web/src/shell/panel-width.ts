export interface PanelWidth {
  // Where the width is kept between visits.
  key: string;
  initial: number;
  min: number;
  max: number;
  // What the rest of the page keeps beside the panel, so the stage never gets squeezed out.
  reserve: number;
}

export const CHAT_WIDTH: PanelWidth = {
  key: "localdot.width.chat",
  initial: 368,
  min: 320,
  max: 640,
  reserve: 600,
};

export const ACTIVITY_WIDTH: PanelWidth = {
  key: "localdot.width.activity",
  initial: 320,
  min: 280,
  max: 520,
  reserve: 1200,
};

export function widthLimits(panel: PanelWidth, viewport: number): { min: number; max: number } {
  return {
    min: panel.min,
    max: Math.max(panel.min, Math.min(panel.max, viewport - panel.reserve)),
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

// Where the edge sits for a pointer `travel` px left of where the drag began.
export function dragWidth(start: number, travel: number, limits: { min: number; max: number }) {
  const raw = start + travel;
  if (raw > limits.max) return limits.max + rubberBand(raw - limits.max);
  if (raw < limits.min) return limits.min + rubberBand(raw - limits.min);
  return raw;
}
