import { describe, expect, it, vi } from "vitest";
import type { StageTheme } from "../stage/theme.ts";

const drawn = vi.hoisted(() => ({
  texts: [] as { style: Record<string, unknown>; text: string }[],
  rects: [] as { x: number; y: number; w: number; h: number; radius: number }[],
  fills: [] as { color: number; alpha: number }[],
  graphics: 0,
}));
vi.mock("pixi.js", () => {
  class Container {
    visible = true;
    children: unknown[] = [];
    scale = { set() {} };
    position = { set() {} };
    addChild(...children: unknown[]) {
      this.children.push(...children);
    }
  }
  class Graphics extends Container {
    constructor() {
      super();
      drawn.graphics++;
    }
    clear() {
      return this;
    }
    roundRect(x: number, y: number, w: number, h: number, radius: number) {
      drawn.rects.push({ x, y, w, h, radius });
      return this;
    }
    fill(fill: { color: number; alpha: number }) {
      drawn.fills.push(fill);
      return this;
    }
  }
  class Text extends Container {
    alpha = 1;
    readonly entry: { style: Record<string, unknown>; text: string };
    constructor({ style }: { style: Record<string, unknown> }) {
      super();
      this.entry = { style, text: "" };
      drawn.texts.push(this.entry);
    }
    get text() {
      return this.entry.text;
    }
    set text(value: string) {
      this.entry.text = value;
    }
    get width() {
      return this.entry.text.length * 10;
    }
    get height() {
      return this.entry.text.split("\n").length * 26;
    }
  }
  return { Container, Graphics, Text };
});

const { burnInText, ExportBurnIn } = await import("./burn-in.ts");

const color = (value: number) => ({ color: value, alpha: 1 });
const theme = {
  font: 'system-ui, -apple-system, "Segoe UI Variable Text", sans-serif',
  hudSolid: color(0x0e0f12),
  text: color(0xeeeff1),
} as StageTheme;

describe("the export's burned-in caption", () => {
  it("draws one chip in the interface's typeface, never Arial", () => {
    const layer = new ExportBurnIn(theme, 1280, 800);
    expect(drawn.texts).toHaveLength(1);
    expect(drawn.graphics).toBe(1);
    expect(drawn.texts[0]?.style.fontFamily).toBe(theme.font);
    expect(JSON.stringify(drawn.texts[0]?.style)).not.toMatch(/arial/i);
    expect(drawn.texts[0]?.style.fontSize).toBe(20);
    layer.draw("Playing at 2×", "Open the report", null);
    expect(layer.visible).toBe(true);
    expect(drawn.texts[0]?.text).toBe("Open the report · Playing at 2×");
    expect(drawn.rects.at(-1)?.radius).toBe(12);
    expect(drawn.fills.at(-1)).toEqual({ color: 0x0e0f12, alpha: 0.92 });
    const chip = drawn.rects.at(-1);
    expect((chip?.x ?? 0) * 2 + (chip?.w ?? 0)).toBe(1280);
  });

  it("puts a gap's note in the same chip, and shows nothing when there is nothing to say", () => {
    const layer = new ExportBurnIn(theme, 1920, 1200);
    layer.draw("Playing at 2×", "Open the report", "user-control");
    expect(drawn.texts.at(-1)?.text.split("\n")).toHaveLength(2);
    expect(drawn.texts.at(-1)?.text).not.toContain("Open the report");
    layer.draw(null, null, null);
    expect(layer.visible).toBe(false);
  });

  it("clips a long step label and keeps the speed after it", () => {
    expect(burnInText("Playing at 4×", "x".repeat(80), null)).toMatch(/^x{59}… · Playing at 4×$/);
    expect(burnInText(null, null, null)).toBeNull();
  });
});
