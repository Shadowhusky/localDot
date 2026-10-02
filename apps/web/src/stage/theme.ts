export interface ThemeColor {
  color: number;
  alpha: number;
}

export interface StageTheme {
  xenon: ThemeColor;
  xenonA10: ThemeColor;
  cursorFill: ThemeColor;
  cursorRim: ThemeColor;
  hudSolid: ThemeColor;
  hudLine: ThemeColor;
  text: ThemeColor;
  text2: ThemeColor;
  haloTarget: ThemeColor;
  shadeCursor: ThemeColor;
  keyBevel: ThemeColor;
  void: ThemeColor;
}

const TOKENS: Record<keyof StageTheme, string> = {
  xenon: "--color-xenon",
  xenonA10: "--color-xenon-a10",
  cursorFill: "--color-cursor-fill",
  cursorRim: "--color-cursor-rim",
  hudSolid: "--color-hud-solid",
  hudLine: "--color-hud-line",
  text: "--color-text",
  text2: "--color-text-2",
  haloTarget: "--color-halo-target",
  shadeCursor: "--color-shade-cursor",
  keyBevel: "--color-key-bevel",
  void: "--color-void",
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

// Every overlay colour comes from theme.css, so a theme pack restyles the stage too.
export function readTheme(style: CSSStyleDeclaration): StageTheme {
  const out = {} as StageTheme;
  for (const [key, token] of Object.entries(TOKENS) as [keyof StageTheme, string][]) {
    out[key] = parseCssColor(style.getPropertyValue(token));
  }
  return out;
}
