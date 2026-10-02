import type { Point, Rect } from "@localdot/protocol";

export type AppToolkit = "gtk" | "libreoffice" | "chromium";
export type Toolkit =
  | "gtk"
  | "libreoffice-gtk"
  | "libreoffice-vcl"
  | "chromium-chrome"
  | "chromium-web";

export interface MapParams {
  g: number;
  c: number;
  m: number;
  windowOrigin: Point;
}

export interface ElementLike {
  role: string;
  inWeb: boolean;
}

// LibreOffice draws these itself (VCL) and reports them one native menu bar too high (S2); anything
// inside a tool bar is VCL-drawn except the GTK text fields embedded in it.
const VCL_ROLES = new Set([
  "tool bar",
  "table",
  "table cell",
  "table column header",
  "table row header",
  "page tab",
  "document text",
  "document spreadsheet",
  "document presentation",
  "paragraph",
  "text frame",
  "canvas",
  "drawing area",
]);
const GTK_DRAWN_ROLES = new Set([
  "text",
  "entry",
  "password text",
  "menu",
  "menu bar",
  "menu item",
  "check menu item",
  "radio menu item",
  "scroll bar",
  "combo box",
]);

export function appToolkit(cls: string): AppToolkit {
  const lower = cls.toLowerCase();
  if (lower.startsWith("chromium") || lower === "chrome") return "chromium";
  if (lower.startsWith("libreoffice") || lower === "soffice") return "libreoffice";
  return "gtk";
}

export function elementToolkit(app: AppToolkit, el: ElementLike, ancestorRoles: string[]): Toolkit {
  if (app === "chromium") return el.inWeb ? "chromium-web" : "chromium-chrome";
  if (app === "gtk") return "gtk";
  if (GTK_DRAWN_ROLES.has(el.role)) return "libreoffice-gtk";
  if (VCL_ROLES.has(el.role) || ancestorRoles.includes("tool bar")) return "libreoffice-vcl";
  return "libreoffice-gtk";
}

// Canonical space = desktop device pixels, one transform per toolkit (spec "Frame mapping").
export function frameToDevice(frame: Rect, toolkit: Toolkit, p: MapParams): Rect {
  switch (toolkit) {
    case "gtk":
    case "libreoffice-gtk": {
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
    case "libreoffice-vcl":
      return { x: frame.x * p.g, y: (frame.y + p.m) * p.g, w: frame.w * p.g, h: frame.h * p.g };
    case "chromium-chrome":
      return { x: frame.x * p.c, y: frame.y * p.c, w: frame.w * p.c, h: frame.h * p.c };
    case "chromium-web":
      throw new RangeError("web content boxes come from CDP, not from the tree");
  }
}

// m: LibreOffice's native menu bar height in frame units, the tallest shallow `menu` row (27 at
// Xft/DPI 96, 45 when LibreOffice renders at 192 dpi with window scaling 1).
export function menuBarHeight(elements: { role: string; frame?: Rect; depth: number }[]): number {
  const menus = elements
    .filter((e) => e.role === "menu" && e.frame && e.depth <= 3)
    .map((e) => e.frame?.h ?? 0);
  return menus.length ? Math.max(...menus) : 27;
}
