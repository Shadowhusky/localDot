import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";
import { cssBlocks, readTokens, type TokenContext } from "../testing/tokens.ts";

const SRC = new URL("../", import.meta.url);
const tokensCss = await readSource(new URL("./tokens.css", import.meta.url));
const motionCss = await readSource(new URL("./motion.css", import.meta.url));
const baseCss = await readSource(new URL("./base.css", import.meta.url));
const stackCss = await readSource(new URL("./stack.css", import.meta.url));
const legacyCss = await readSource(new URL("../theme.css", import.meta.url));
const onboardingCss = await readSource(new URL("../onboarding/onboarding.css", import.meta.url));
const page = await readSource(new URL("../../index.html", import.meta.url));
const stylesheets = (await readdir(SRC, { recursive: true }))
  .filter((path) => path.endsWith(".css") && !path.includes("_spike"))
  .sort();
const legacySheets = stylesheets.filter((path) => !path.startsWith("ui/"));

type Rgba = [number, number, number, number];

function rgba(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt((hex[1] as string).slice(i, i + 2), 16));
    return [r, g, b, 1] as Rgba;
  }
  const fn = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(value);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] ? Number(fn[4]) : 1];
  throw new Error(`not a colour: ${value}`);
}

function over([r, g, b, a]: Rgba, ground: Rgba): Rgba {
  return [r, g, b].map((c, i) => a * c + (1 - a) * (ground[i] as number)).concat(1) as Rgba;
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// WCAG 2 contrast ratio of two opaque colours.
function contrast(a: Rgba, b: Rgba): number {
  const luminance = ([r, g, b]: Rgba) =>
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// Björn Ottosson's OKLab matrices.
function oklab([r, g, b]: Rgba): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map(linear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklch(color: Rgba): [number, number, number] {
  const [L, A, B] = oklab(color);
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

function deltaE(a: Rgba, b: Rgba): number {
  const [p, q] = [oklab(a), oklab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

// A little over one just-noticeable difference (about .02 in OKLab).
const VISIBLY_APART = 0.023;

function palette(context: TokenContext) {
  const tokens = readTokens([tokensCss], context);
  return (name: string): Rgba => rgba(tokens.get(`--color-${name}`) ?? `no --color-${name}`);
}

const WHITE: Rgba = [255, 255, 255, 1];
const BLACK: Rgba = [0, 0, 0, 1];
const MORE_CONTRAST = "prefers-contrast: more";
const CONTEXTS: TokenContext[] = [
  { appearance: "graphite" },
  { appearance: "midnight" },
  { appearance: "graphite", media: [MORE_CONTRAST] },
  { appearance: "midnight", media: [MORE_CONTRAST] },
];

describe("colour tokens", () => {
  for (const context of CONTEXTS) {
    const label = `${context.appearance}${context.media ? ", more contrast" : ""}`;
    const color = palette(context);

    it(`keeps text at 4.5:1 on every surface it may sit on (${label})`, () => {
      for (const ground of [
        "void",
        "console",
        "well",
        "raised",
        "raised-2",
        "overlay",
        "popover",
      ]) {
        for (const text of ["fg-1", "fg-2", "fg-3"]) {
          if (text === "fg-3" && ["raised-2", "overlay", "popover"].includes(ground)) continue;
          const ratio = contrast(color(text), color(ground));
          expect(ratio, `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    // Glass is .72 so the picture reads through it; over a white page the elapsed time (fg-2) holds
    // 3:1, and more contrast makes the glass solid.
    it(`keeps the island's words legible over a white or a black frame (${label})`, () => {
      for (const frame of [WHITE, BLACK]) {
        const glass = over(color("glass"), frame);
        expect(contrast(color("fg-1"), glass), "fg-1 on glass").toBeGreaterThanOrEqual(4.5);
        const least = frame === BLACK || context.media ? 4.5 : 3;
        expect(contrast(color("fg-2"), glass), "fg-2 on glass").toBeGreaterThanOrEqual(least);
      }
    });

    it(`gives field edges 3:1 on the void and on raised surfaces (${label})`, () => {
      for (const ground of ["void", "raised"]) {
        const ratio = contrast(color("field-line"), color(ground));
        expect(ratio, `field-line on ${ground}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("keeps secondary and tertiary text apart in both appearances", () => {
    for (const appearance of ["graphite", "midnight"] as const) {
      const color = palette({ appearance });
      expect(contrast(color("fg-2"), color("fg-3")), appearance).toBeGreaterThanOrEqual(1.5);
    }
  });

  it("builds Midnight on Graphite's lightness ramp at hue 255", () => {
    const graphite = palette({ appearance: "graphite" });
    const midnight = palette({ appearance: "midnight" });
    for (const step of ["void", "console", "well", "raised", "raised-2", "overlay", "popover"]) {
      const [lightness] = oklch(graphite(step));
      const [l, c, h] = oklch(midnight(step));
      expect(Math.abs(l - lightness), `${step} lightness`).toBeLessThan(0.005);
      expect(c, `${step} chroma`).toBeGreaterThan(0.015);
      expect(c, `${step} chroma`).toBeLessThan(0.045);
      expect(Math.abs(h - 255), `${step} hue`).toBeLessThan(6);
    }
  });

  it("keeps Midnight's raised surfaces visibly apart from Graphite's", () => {
    const graphite = palette({ appearance: "graphite" });
    const midnight = palette({ appearance: "midnight" });
    for (const step of ["console", "raised", "raised-2", "overlay", "popover"]) {
      const distance = deltaE(graphite(step), midnight(step));
      expect(distance, step).toBeGreaterThanOrEqual(VISIBLY_APART);
    }
  });

  it("draws the two theme tiles visibly apart", () => {
    const tokens = readTokens([tokensCss]);
    const bands = (appearance: string) => {
      const tile = cssBlocks(onboardingCss).find(
        (block) => block.selector === `.appearance-swatch[data-appearance="${appearance}"]`,
      );
      const names = [...(tile?.body ?? "").matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
      return names.map((name) => rgba(tokens.get(name as string) ?? `no ${name}`));
    };
    const [graphite, midnight] = [bands("graphite"), bands("midnight")];
    expect(graphite).toHaveLength(2);
    expect(midnight).toHaveLength(2);
    const widest = Math.max(...graphite.map((band, i) => deltaE(band, midnight[i] as Rgba)));
    expect(widest).toBeGreaterThanOrEqual(VISIBLY_APART);
  });

  it("makes glass solid for more contrast or less transparency", () => {
    for (const appearance of ["graphite", "midnight"] as const) {
      for (const feature of [MORE_CONTRAST, "prefers-reduced-transparency: reduce"]) {
        const tokens = readTokens([tokensCss], { appearance, media: [feature] });
        expect(tokens.get("--color-glass"), `${appearance}, ${feature}`).toBe(
          tokens.get("--color-glass-solid"),
        );
      }
    }
  });
});

describe("token layer", () => {
  it("declares each token once, so a legacy rule cannot outrank it from a later layer", async () => {
    const owned = new Set(readTokens([tokensCss]).keys());
    const redeclared: string[] = [];
    for (const path of legacySheets) {
      for (const block of cssBlocks(await readSource(new URL(path, SRC)))) {
        for (const [, name] of block.body.matchAll(/(--[\w-]+)\s*:/g)) {
          if (owned.has(name as string)) redeclared.push(`${path} ${name}`);
        }
      }
    }
    expect(legacySheets).toContain("theme.css");
    expect(redeclared).toEqual([]);
  });

  it("uses a custom media name only where the stylesheet can see it", async () => {
    const bundled = [...stackCss.matchAll(/@import "\.\/([\w-]+\.css)"/g)].map((m) => `ui/${m[1]}`);
    const defined = (css: string) =>
      [...css.matchAll(/@custom-media (--[\w-]+)/g)].map((m) => m[1]);
    const shared = defined(tokensCss);
    const unseen: string[] = [];
    for (const path of stylesheets) {
      const css = await readSource(new URL(path, SRC));
      const visible = new Set([...defined(css), ...(bundled.includes(path) ? shared : [])]);
      for (const [prelude] of css.matchAll(/@media[^{]*/g)) {
        for (const [, name] of prelude.matchAll(/\((--[\w-]+)\)/g)) {
          if (!visible.has(name as string)) unseen.push(`${path} ${name}`);
        }
      }
    }
    expect(bundled).toContain("ui/tokens.css");
    expect(unseen).toEqual([]);
  });

  it("points the legacy colour names at the roles", () => {
    const tokens = readTokens([tokensCss, legacyCss]);
    for (const [legacy, role] of [
      ["surface", "raised"],
      ["surface-2", "raised-2"],
      ["line", "popover"],
      ["text", "fg-1"],
      ["text-2", "fg-2"],
      ["text-3", "fg-3"],
    ]) {
      expect(legacyCss).toContain(`--color-${legacy}: var(--color-${role});`);
      expect(tokens.get(`--color-${legacy}`)).toBe(tokens.get(`--color-${role}`));
    }
  });

  it("strengthens the legacy line with every other hairline when the viewer asks for contrast", () => {
    const tokens = readTokens([tokensCss, legacyCss], { media: [MORE_CONTRAST] });
    expect(tokens.get("--color-line")).toBe(tokens.get("--color-field-line"));
    expect(tokens.get("--color-hairline")).toBe(tokens.get("--color-field-line"));
  });

  it("maps every duration into 120–150 ms under reduced motion", () => {
    const normal = readTokens([tokensCss, motionCss]);
    const reduced = readTokens([tokensCss, motionCss], {
      media: ["prefers-reduced-motion: reduce"],
    });
    const durations = [...normal.keys()].filter((name) => name.startsWith("--dur-"));
    expect(durations).toHaveLength(15);
    for (const name of durations) {
      const ms = Number(/^(\d+)ms$/.exec(reduced.get(name) ?? "")?.[1]);
      expect(ms, name).toBeGreaterThanOrEqual(120);
      expect(ms, name).toBeLessThanOrEqual(150);
    }
    expect(reduced.get("--ease-spring")).toBe(normal.get("--ease-standard"));
  });

  it("tints the browser chrome with the void", () => {
    const content = /<meta name="theme-color" content="(#[0-9a-f]{6})" \/>/.exec(page)?.[1];
    expect(content).toBe(readTokens([tokensCss]).get("--color-void"));
  });
});

describe("focus", () => {
  // The approval card's ring predates the token layer; it goes when that card moves onto the kit.
  const RAW_RING_ALLOWED = ["agent/safety.css"];
  const RAW_COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|color)\(|xenon/i;

  async function focusRules() {
    const rules: { path: string; selector: string; body: string }[] = [];
    for (const path of stylesheets) {
      for (const { selector, body } of cssBlocks(await readSource(new URL(path, SRC)))) {
        if (/:focus/.test(selector))
          rules.push({ path, selector: selector.replace(/\s+/g, " "), body });
      }
    }
    expect(rules.map((rule) => rule.path)).toContain("agent/safety.css");
    return rules;
  }

  it("draws the ring in a text role, never in xenon or a raw colour", async () => {
    expect(baseCss).toMatch(
      /:focus-visible \{\s*outline: var\(--focus-width\) solid var\(--color-fg-1\);/,
    );
    const raw = (await focusRules())
      .filter(({ path, body }) => RAW_COLOUR.test(body) && !RAW_RING_ALLOWED.includes(path))
      .map(({ path, selector }) => `${path} ${selector}`);
    expect(raw).toEqual([]);
  });

  it("draws every ring at the focus width, so more contrast widens it", async () => {
    const fixed = (await focusRules())
      .filter(({ body }) => /outline(?:-width)?\s*:[^;]*\b\d+px/.test(body))
      .map(({ path, selector }) => `${path} ${selector}`);
    expect(fixed).toEqual([]);
  });
});
