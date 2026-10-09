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
      "--color-xenon": "#3fb5de",
      "--color-xenon-a10": "rgba(63, 181, 222, 0.1)",
      "--color-cursor-fill": "#ffffff",
      "--color-cursor-rim": "#121316",
      "--color-glass-solid": "rgba(14, 15, 18, 0.92)",
      "--color-glass-line": "rgba(255, 255, 255, 0.1)",
      "--color-fg-1": "#eeeff1",
      "--color-fg-2": "#a8abb0",
      "--color-halo-target": "rgba(10, 11, 13, 0.35)",
      "--color-shade-cursor": "rgba(0, 0, 0, 0.4)",
      "--color-key-bevel": "rgba(255, 255, 255, 0.06)",
      "--color-void": "#0a0b0d",
      "--font-ui": ' system-ui, -apple-system, "Segoe UI Variable Text", sans-serif',
    };
    const theme = readTheme({
      getPropertyValue: (k: string) => vars[k] ?? "",
    } as unknown as CSSStyleDeclaration);
    expect(theme.xenon).toEqual({ color: 0x3fb5de, alpha: 1 });
    expect(theme.text2).toEqual({ color: 0xa8abb0, alpha: 1 });
    expect(theme.font).toBe('system-ui, -apple-system, "Segoe UI Variable Text", sans-serif');
    expect(theme.haloTarget.alpha).toBeCloseTo(0.35, 6);
    expect(Object.keys(theme).sort()).toEqual([
      "cursorFill",
      "cursorRim",
      "font",
      "haloTarget",
      "hudLine",
      "hudSolid",
      "keyBevel",
      "shadeCursor",
      "text",
      "text2",
      "void",
      "xenon",
      "xenonA10",
    ]);
  });

  it("refuses a style without the UI font, rather than drawing labels in a fallback", () => {
    const style = {
      getPropertyValue: (k: string) => (k === "--font-ui" ? "" : "#000000"),
    } as unknown as CSSStyleDeclaration;
    expect(() => readTheme(style)).toThrow(/--font-ui/);
  });
});
