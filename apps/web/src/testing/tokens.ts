// Resolves the custom properties that stylesheets declare on :root, as a browser would for one
// appearance and set of media features. jsdom computes none of them, so tests read the source.
export interface TokenContext {
  appearance?: "graphite" | "midnight";
  // Media features that match, written as in the stylesheet: "prefers-contrast: more".
  media?: string[];
}

export interface CssBlock {
  media: string[];
  selector: string;
  body: string;
}

const MIDNIGHT = ':root[data-appearance="midnight"]';

export function cssBlocks(css: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  const preludes: string[] = [];
  let text = "";
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (char === "{") {
      preludes.push(text.slice(text.lastIndexOf(";") + 1).trim());
      text = "";
    } else if (char === "}") {
      const selector = preludes.pop() ?? "";
      if (text.trim()) {
        blocks.push({
          media: preludes.filter((p) => p.startsWith("@media")),
          selector,
          body: text,
        });
      }
      text = "";
    } else text += char;
  }
  return blocks;
}

function applies(block: CssBlock, appearance: string, media: string[]): boolean {
  if (!block.media.every((prelude) => media.some((feature) => prelude.includes(feature)))) {
    return false;
  }
  if (block.selector.startsWith("@theme")) return true;
  const selectors = block.selector.split(",").map((s) => s.trim());
  return selectors.includes(":root") || (appearance === "midnight" && selectors.includes(MIDNIGHT));
}

export function readTokens(sources: string[], context: TokenContext = {}): Map<string, string> {
  const { appearance = "graphite", media = [] } = context;
  const raw = new Map<string, string>();
  for (const block of sources.flatMap(cssBlocks)) {
    if (!applies(block, appearance, media)) continue;
    for (const [, name, value] of block.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      raw.set(name as string, (value as string).replace(/\s+/g, " ").trim());
    }
  }
  const resolve = (value: string, seen: string[]): string =>
    value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
      const next = raw.get(name);
      if (next === undefined || seen.includes(name)) throw new Error(`unresolved ${name}`);
      return resolve(next, [...seen, name]);
    });
  return new Map([...raw].map(([name, value]) => [name, resolve(value, [name])]));
}
