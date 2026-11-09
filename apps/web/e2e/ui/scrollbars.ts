import type { Page } from "@playwright/test";

export interface StrayScrollbar {
  where: string;
  axis: "x" | "y";
  // How far its content goes past it; none for one that always shows a bar.
  over: number;
  why: string;
}

// Meant to scroll sideways: what can't wrap and is read a line at a time, and strips of cards.
const SIDEWAYS = [
  "pre",
  "code",
  "table",
  ".md-table",
  ".diff-viewer",
  ".viewer-table-scroll",
  ".file-preview-table",
  ".viewer-code",
  ".terminal-viewer",
  ".thread-bubble-files",
  ".thread-pictures",
].join(",");

// Overflow this small can only be rounding, padding or something drawn past an edge.
const SLIGHT = 2;
// As far as a control reaches past its edge for the pointer, which is scrollable overflow. Further
// than this, what a ::before or ::after adds is a spacer, there on purpose.
const REACH = 12;

// Every element that could show a scrollbar with nothing to scroll to. Measured with classic
// scrollbars, the kind that take room, whatever this machine's own setting: what a mouse on a Mac
// and every Windows and Linux desktop gets. They stay on for a few frames, for what fits itself to
// its room to do so. An element that draws none is left alone.
export const strayScrollbars = (page: Page) =>
  page.evaluate(
    async ({ sideways, slight, reach }): Promise<StrayScrollbar[]> => {
      const frames = async (count: number) => {
        for (let frame = 0; frame < count; frame++) await new Promise(requestAnimationFrame);
      };
      const every = [...document.querySelectorAll<HTMLElement>("*")];
      const hidden = every.filter((node) => getComputedStyle(node).scrollbarWidth === "none");
      for (const node of hidden) node.style.setProperty("scrollbar-width", "none", "important");
      const classic = new CSSStyleSheet();
      classic.replaceSync(`
        * { scrollbar-width: auto !important; scrollbar-color: auto !important; }
        *::-webkit-scrollbar { width: 12px !important; height: 12px !important; }
      `);
      const without = new CSSStyleSheet();
      without.replaceSync("*::before, *::after { content: none !important; }");
      const own = [...document.adoptedStyleSheets];
      document.adoptedStyleSheets = [...own, classic];
      await frames(4);

      const name = (node: HTMLElement) => {
        const classes = [...node.classList].slice(0, 3).join(".");
        const label = node.getAttribute("aria-label");
        return `${node.tagName.toLowerCase()}${classes ? `.${classes}` : ""}${label ? ` "${label}"` : ""}`;
      };
      const size = (node: HTMLElement) => ({
        x: node.scrollWidth - node.clientWidth,
        y: node.scrollHeight - node.clientHeight,
      });
      const scrollers: {
        node: HTMLElement;
        x: string;
        y: string;
        over: { x: number; y: number };
      }[] = [];
      for (const node of every) {
        if (hidden.includes(node)) continue;
        const style = getComputedStyle(node);
        const viewport = node === document.documentElement;
        const x = viewport && style.overflowX === "visible" ? "auto" : style.overflowX;
        const y = viewport && style.overflowY === "visible" ? "auto" : style.overflowY;
        if (!/auto|scroll/.test(x) && !/auto|scroll/.test(y)) continue;
        if (!node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        if (!node.clientWidth || !node.clientHeight) continue;
        scrollers.push({ node, x, y, over: size(node) });
      }
      document.adoptedStyleSheets = [...own, classic, without];
      const found: StrayScrollbar[] = [];
      for (const { node, x, y, over } of scrollers) {
        const bare = size(node);
        const check = (axis: "x" | "y", flow: string) => {
          if (!/auto|scroll/.test(flow)) return;
          const by = over[axis];
          const report = (why: string) => found.push({ where: name(node), axis, over: by, why });
          if (by <= 0) {
            if (flow === "scroll") report("always shows a bar, with nothing to scroll");
          } else if (bare[axis] <= 0 && by <= reach)
            report("only what its ::before or ::after draws overflows");
          else if (by <= slight) report("overflows by a pixel or two");
          else if (axis === "x" && !node.closest(sideways))
            report("scrolls sideways, though it isn't meant to");
        };
        check("x", x);
        check("y", y);
      }
      document.adoptedStyleSheets = own;
      for (const node of hidden) node.style.removeProperty("scrollbar-width");
      await frames(4);
      return found;
    },
    { sideways: SIDEWAYS, slight: SLIGHT, reach: REACH },
  );
