import { describe, expect, it } from "vitest";
import { readSource } from "./testing/read-source.ts";

const theme = await readSource(new URL("./theme.css", import.meta.url));
const app = await readSource(new URL("./app.css", import.meta.url));
const appearance = await readSource(new URL("./onboarding/onboarding.css", import.meta.url));

function token(source: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`).exec(source);
  if (!match?.[1]) throw new Error(`no hex token --${name}`);
  return match[1];
}

// WCAG 2 relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("theme", () => {
  it("keeps Midnight text at readable contrast on its surfaces", () => {
    for (const text of ["color-text", "color-text-2", "color-text-3"]) {
      const foreground = text === "color-text" ? token(theme, text) : token(appearance, text);
      for (const ground of ["color-void", "color-surface", "color-surface-2"])
        expect(
          contrast(foreground, token(appearance, ground)),
          `${text} on ${ground}`,
        ).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("gives every text colour at least 4.5:1 on the void and on the surfaces text sits on", () => {
    for (const text of ["color-text", "color-text-2", "color-text-3"]) {
      for (const ground of ["color-void", "color-surface"]) {
        const ratio = contrast(token(theme, text), token(theme, ground));
        expect(ratio, `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("lets a long caption wrap anywhere instead of spilling out of the stage column", () => {
    const caption = /\.caption\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
    expect(caption).toMatch(/overflow-wrap:\s*anywhere;/);
  });
});
