import type { Point, Rect } from "@localdot/protocol";

export type AppToolkit = "gtk" | "libreoffice" | "chromium";
// The accessibility helper returns LibreOffice's frames already corrected to GTK frame units.
export type FrameSpace = "gtk" | "chrome";

export interface MapParams {
  g: number;
  c: number;
  windowOrigin: Point;
}

export function appToolkit(cls: string): AppToolkit {
  const lower = cls.toLowerCase();
  if (lower.startsWith("chromium") || lower === "chrome") return "chromium";
  if (lower.startsWith("libreoffice") || lower === "soffice") return "libreoffice";
  return "gtk";
}

// Canonical space = desktop device pixels (spec "Frame mapping").
export function frameToDevice(frame: Rect, space: FrameSpace, p: MapParams): Rect {
  if (space === "chrome")
    return { x: frame.x * p.c, y: frame.y * p.c, w: frame.w * p.c, h: frame.h * p.c };
  // device = windowOrigin + (frame − floor(windowOrigin / g)) × g, never plain frame × g.
  const ox = Math.floor(p.windowOrigin.x / p.g);
  const oy = Math.floor(p.windowOrigin.y / p.g);
  return {
    x: p.windowOrigin.x + (frame.x - ox) * p.g,
    y: p.windowOrigin.y + (frame.y - oy) * p.g,
    w: frame.w * p.g,
    h: frame.h * p.g,
  };
}
