export interface ThemeColor {
  color: number;
  alpha: number;
}

export interface StageTheme {
  font: string;
  xenon: ThemeColor;
  attention: ThemeColor;
  cursorFill: ThemeColor;
  cursorRim: ThemeColor;
  hudSolid: ThemeColor;
  hudLine: ThemeColor;
  text: ThemeColor;
  text2: ThemeColor;
  dragUnder: ThemeColor;
  shadeCursor: ThemeColor;
  keyBevel: ThemeColor;
  void: ThemeColor;
  glass: ThemeColor;
  glyphLight: ThemeColor;
  glyphMid: ThemeColor;
  glyphShade: ThemeColor;
  spill: ThemeColor;
  spillXenon: ThemeColor;
}

type ColorKey = Exclude<keyof StageTheme, "font">;

const TOKENS: Record<ColorKey, string> = {
  xenon: "--color-stage-xenon",
  attention: "--color-stage-attention",
  cursorFill: "--color-cursor-fill",
  cursorRim: "--color-cursor-rim",
  hudSolid: "--color-stage-hud",
  hudLine: "--color-stage-hud-line",
  text: "--color-stage-fg-1",
  text2: "--color-stage-fg-2",
  dragUnder: "--color-drag-under",
  shadeCursor: "--color-shade-cursor",
  keyBevel: "--color-stage-key-bevel",
  void: "--color-stage-void",
  glass: "--color-stage-glass",
  glyphLight: "--color-glyph-light",
  glyphMid: "--color-glyph-mid",
  glyphShade: "--color-glyph-shade",
  spill: "--color-stage-spill",
  spillXenon: "--color-stage-spill-xenon",
};

export function parseCssColor(value: string): ThemeColor {
  const s = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    const h = hex[1] as string;
    const full =
      h.length <= 4
        ? h
            .split("")
            .map((c) => c + c)
            .join("")
        : h;
    return {
      color: Number.parseInt(full.slice(0, 6), 16),
      alpha: full.length === 8 ? Number.parseInt(full.slice(6), 16) / 255 : 1,
    };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (rgba) {
    const [r, g, b] = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
    return { color: (r << 16) | (g << 8) | b, alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  }
  throw new RangeError(`unsupported CSS colour ${JSON.stringify(value)}`);
}

// Every overlay colour and the label font come from the CSS tokens, so an appearance restyles the
// stage too.
export function readTheme(style: CSSStyleDeclaration): StageTheme {
  const font = style.getPropertyValue("--font-ui").trim();
  if (!font) throw new RangeError("no --font-ui token");
  const out = { font } as StageTheme;
  for (const [key, token] of Object.entries(TOKENS) as [ColorKey, string][]) {
    out[key] = parseCssColor(style.getPropertyValue(token));
  }
  return out;
}
