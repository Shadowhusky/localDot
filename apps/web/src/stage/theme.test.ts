import { describe, expect, it } from "vitest";
import { parseCssColor, readTheme } from "./theme.ts";

describe("theme tokens", () => {
  it("parses hex and rgba colours into Pixi numbers and alphas", () => {
    expect(parseCssColor("#3FB5DE")).toEqual({ color: 0x3fb5de, alpha: 1 });
    expect(parseCssColor(" rgba(14, 15, 18, 0.92) ")).toEqual({ color: 0x0e0f12, alpha: 0.92 });
    expect(parseCssColor("rgb(255, 255, 255)")).toEqual({ color: 0xffffff, alpha: 1 });
    expect(parseCssColor("#abc")).toEqual({ color: 0xaabbcc, alpha: 1 });
    expect(parseCssColor("#3fb5de1a")).toEqual({ color: 0x3fb5de, alpha: 26 / 255 });
    expect(parseCssColor("#abcd")).toEqual({ color: 0xaabbcc, alpha: 221 / 255 });
    expect(() => parseCssColor("hotpink")).toThrow(/colour/);
  });

  it("reads every overlay colour and the label font from the CSS tokens", () => {
    const vars: Record<string, string> = {
      "--color-stage-xenon": "#3fb5de",
      "--color-stage-attention": "#e9b44c",
      "--color-xenon-a10": "rgba(63, 181, 222, 0.1)",
      "--color-cursor-fill": "#ffffff",
      "--color-cursor-rim": "#121316",
      "--color-stage-hud": "rgba(14, 15, 18, 0.92)",
      "--color-stage-hud-line": "rgba(255, 255, 255, 0.1)",
      "--color-stage-fg-1": "#eeeff1",
      "--color-stage-fg-2": "#a8abb0",
      "--color-drag-under": "rgba(10, 11, 13, 0.12)",
      "--color-shade-cursor": "rgba(0, 0, 0, 0.35)",
      "--color-stage-key-bevel": "rgba(255, 255, 255, 0.06)",
      "--color-stage-void": "#0a0b0d",
      "--color-stage-glass": "rgba(16, 17, 20, 0.84)",
      "--color-glyph-light": "#ffffff",
      "--color-glyph-mid": "#d9dce0",
      "--color-glyph-shade": "#9fa4ab",
      "--color-stage-spill": "rgba(220, 228, 238, 0.07)",
      "--color-stage-spill-xenon": "rgba(63, 181, 222, 0.11)",
      "--font-ui": ' system-ui, -apple-system, "Segoe UI Variable Text", sans-serif',
    };
    const theme = readTheme({
      getPropertyValue: (k: string) => vars[k] ?? "",
    } as unknown as CSSStyleDeclaration);
    expect(theme.xenon).toEqual({ color: 0x3fb5de, alpha: 1 });
    expect(theme.text2).toEqual({ color: 0xa8abb0, alpha: 1 });
    expect(theme.font).toBe('system-ui, -apple-system, "Segoe UI Variable Text", sans-serif');
    expect(theme.dragUnder.alpha).toBeCloseTo(0.12, 6);
    expect(Object.keys(theme).sort()).toEqual([
      "attention",
      "cursorFill",
      "cursorRim",
      "dragUnder",
      "font",
      "glass",
      "glyphLight",
      "glyphMid",
      "glyphShade",
      "hudLine",
      "hudSolid",
      "keyBevel",
      "shadeCursor",
      "spill",
      "spillXenon",
      "text",
      "text2",
      "void",
      "xenon",
    ]);
  });

  it("refuses a style without the UI font, rather than drawing labels in a fallback", () => {
    const style = {
      getPropertyValue: (k: string) => (k === "--font-ui" ? "" : "#000000"),
    } as unknown as CSSStyleDeclaration;
    expect(() => readTheme(style)).toThrow(/--font-ui/);
  });
});
