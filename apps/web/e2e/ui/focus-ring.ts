import { expect, type Locator, type Page, test } from "@playwright/test";
import { wearAppearance } from "./contrast.ts";

// Waits for what moves to stop, such as a sheet rising; a loop that never ends is left to run.
export const untilStill = (page: Page) =>
  page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().endTime === Number.POSITIVE_INFINITY,
      ),
  );

// Each of `targets`, focused by keyboard in turn, in Graphite and Daylight, with more contrast and
// without, and, given a `picture` name, a picture of the group round the first, wearing its ring.
export async function ringFaultsInEach(page: Page, targets: Locator, picture?: string) {
  await expect(targets.first()).toBeVisible();
  const count = await targets.count();
  const faults: string[] = [];
  await keyboardFocus(page);
  for (const contrast of ["no-preference", "more"] as const) {
    await page.emulateMedia({ contrast });
    for (const appearance of ["graphite", "daylight"] as const) {
      await wearAppearance(page, appearance);
      await untilStill(page);
      for (let at = 0; at < count; at++)
        for (const fault of await ringFaults(targets.nth(at)))
          faults.push(`${appearance}, ${contrast} contrast: ${fault}`);
      if (!picture) continue;
      await ringFaults(targets.first());
      const box = await targets.first().evaluate((target) => {
        const { x, y, width, height } = (
          target.closest(".ui-radio-cards, .ui-group") ?? target
        ).getBoundingClientRect();
        return { x, y, width, height };
      });
      const view = page.viewportSize() ?? { width: 0, height: 0 };
      const [x, y] = [Math.max(0, box.x - 12), Math.max(0, box.y - 12)];
      await page.screenshot({
        path: test.info().outputPath(`${picture}-${appearance}-${contrast}.png`),
        clip: {
          x,
          y,
          width: Math.min(box.width + 24, view.width - x),
          height: Math.min(box.height + 24, view.height - y),
        },
      });
    }
  }
  await page.emulateMedia({ contrast: null });
  return faults;
}

// Tabs until something wears the keyboard's ring, so what a script focuses next wears it too.
// WebKit's Tab, as Safari's, may pass over buttons and radios to the page itself; Option-Tab doesn't.
export async function keyboardFocus(page: Page) {
  for (const key of ["Tab", "Tab", "Alt+Tab", "Alt+Tab", "Alt+Tab"]) {
    await page.keyboard.press(key);
    if (await page.evaluate(() => document.activeElement?.matches(":focus-visible"))) return;
  }
  throw new Error("Tab never showed a focus ring");
}

// Focuses `target`, after `keyboardFocus`, and says where any box that clips its focus ring cuts
// it, at an edge or round a corner.
export const ringFaults = (target: Locator) => target.evaluate(cutRing);

// The ring is what focus changes on the target and the few boxes round it: an outline, or a shadow
// drawn outside. It is read against focus parked on a stand-in beside them, so nothing round them
// sees focus leave. A box clips across, down or both; a scroller's range is all of it, as focus
// scrolls the target into view, and a box with round corners clips them round.
function cutRing(element: Element): string[] {
  const faults: string[] = [];
  const target = element as HTMLElement;
  const name =
    (
      target.getAttribute("aria-label") ??
      target.closest("label")?.textContent ??
      target.textContent
    )
      ?.trim()
      .replace(/\s+/g, " ")
      .slice(0, 48) || target.tagName.toLowerCase();
  const chain: HTMLElement[] = [];
  for (let node: HTMLElement | null = target; node && chain.length < 4; node = node.parentElement)
    chain.push(node);
  const read = () =>
    chain.map((node) => {
      for (const animation of node.getAnimations())
        if (animation instanceof CSSTransition) animation.finish();
      const style = getComputedStyle(node);
      return {
        outline:
          style.outlineStyle === "none" ? "" : `${style.outlineOffset} ${style.outlineWidth}`,
        shadows: style.boxShadow.split(/,(?![^(]*\))/).map((shadow) => shadow.trim()),
      };
    });
  target.focus();
  if (!target.matches(":focus-visible")) faults.push(`${name}: no keyboard focus`);
  const on = read();
  const stand = document.createElement("span");
  stand.tabIndex = -1;
  (chain.at(-1)?.parentElement ?? document.body).append(stand);
  stand.focus({ preventScroll: true });
  const off = read();
  target.focus();
  stand.remove();
  read();

  const lengths = (shadow: string) =>
    shadow
      .replace(/[a-z-]+\([^)]*\)/g, "")
      .trim()
      .split(/\s+/)
      .map(Number.parseFloat)
      .filter((length) => !Number.isNaN(length));
  const rings: { node: HTMLElement; edges: number[]; radii: number[] }[] = [];
  chain.forEach((node, index) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    const corners = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ].map(Number.parseFloat);
    // Edges grow out by left, top, right and bottom; round corners grow with them.
    const ring = (left: number, top: number, right: number, bottom: number, grow: number) =>
      rings.push({
        node,
        edges: [box.left - left, box.top - top, box.right + right, box.bottom + bottom],
        radii: corners.map((radius) => (radius > 0 ? Math.max(0, radius + grow) : 0)),
      });
    const [now, before] = [on[index], off[index]];
    if (!now || !before) return;
    if (now.outline && now.outline !== before.outline) {
      const reach = Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth);
      ring(reach, reach, reach, reach, reach);
    }
    for (const shadow of now.shadows) {
      if (before.shadows.includes(shadow) || /inset|none/.test(shadow)) continue;
      const [x = 0, y = 0, blur = 0, spread = 0] = lengths(shadow);
      ring(blur + spread - x, blur + spread - y, blur + spread + x, blur + spread + y, spread);
    }
  });
  if (!rings.length) faults.push(`${name}: no focus ring`);

  const CORNERS = ["top left", "top right", "bottom right", "bottom left"];
  const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll";
  for (const { node: painter, edges, radii } of rings) {
    // An absolute box is clipped from its containing block up; a fixed one by none of these. Past
    // the nearest scroller on an axis, boxes clip the scroller, not the ring.
    let from: Element | null = null;
    let [acrossDone, downDone] = [false, false];
    for (
      let node = painter;
      node.parentElement && node.parentElement !== document.documentElement;
    ) {
      const position = getComputedStyle(node).position;
      if (position === "fixed") break;
      if (position === "absolute") from = node.offsetParent;
      node = node.parentElement;
      if (from && node !== from) continue;
      from = null;
      const style = getComputedStyle(node);
      const acrossCut = !acrossDone && style.overflowX !== "visible";
      const downCut = !downDone && style.overflowY !== "visible";
      acrossDone ||= scrolls(style.overflowX);
      downDone ||= scrolls(style.overflowY);
      if (!acrossCut && !downCut) continue;
      const at = node.getBoundingClientRect();
      const x0 = at.left + node.clientLeft - node.scrollLeft;
      const y0 = at.top + node.clientTop - node.scrollTop;
      const width = scrolls(style.overflowX) ? node.scrollWidth : node.clientWidth;
      const height = scrolls(style.overflowY) ? node.scrollHeight : node.clientHeight;
      const what = node.classList[0] ?? node.tagName.toLowerCase();
      const cut = (where: string, by: number) => {
        if (by > 0.5) faults.push(`${name}: ring cut at ${what}'s ${where} by ${by.toFixed(1)} px`);
      };
      const [left, top, right, bottom] = [
        (edges[0] ?? 0) - x0,
        (edges[1] ?? 0) - y0,
        (edges[2] ?? 0) - x0,
        (edges[3] ?? 0) - y0,
      ];
      if (acrossCut) {
        cut("left", -left);
        cut("right", right - width);
      }
      if (downCut) {
        cut("top", -top);
        cut("bottom", bottom - height);
      }
      if (!acrossCut || !downCut) continue;
      const border = Number.parseFloat(style.borderTopWidth);
      const clipRadii = [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ].map((radius) => Math.max(0, Number.parseFloat(radius) - border));
      // Each corner: where it is, and which way is in.
      const places = [
        [0, 0, 1, 1, left, top],
        [width, 0, -1, 1, right, top],
        [width, height, -1, -1, right, bottom],
        [0, height, 1, -1, left, bottom],
      ] as const;
      places.forEach(([cx, cy, inX, inY, ringX, ringY], corner) => {
        const clip = clipRadii[corner] ?? 0;
        if (!clip) return;
        const own = radii[corner] ?? 0;
        let worst = 0;
        for (let step = 0; step <= 6; step++) {
          const angle = (step / 6) * (Math.PI / 2);
          const x = ringX + inX * own * (1 - Math.cos(angle));
          const y = ringY + inY * own * (1 - Math.sin(angle));
          if (inX * (x - cx) >= clip || inY * (y - cy) >= clip) continue;
          const out = Math.hypot(x - (cx + inX * clip), y - (cy + inY * clip)) - clip;
          worst = Math.max(worst, out);
        }
        cut(`${CORNERS[corner]} corner`, worst);
      });
    }
  }
  return faults;
}
