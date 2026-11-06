import type { Locator, Page } from "@playwright/test";
import type { ViewStyle } from "../../src/shell/view-style.ts";
import { composer, expect, isPhone, runAt, test } from "./harness.ts";

// The composer opening from its one row and folding back, read on every frame it is drawn, while what
// opens it is typed or pasted at once: the words stay inside the card and clear of the row of controls
// that opens under them, and the field never scrolls them away once the card has the room.
runAt("c14", "c39", "w14", "w39");
test.use({ reducedMotion: "no-preference", fixedClock: false });

const MESSAGE = "Build me a little 3D game where the ball is you.";
const LONG = Array.from({ length: 6 }, (_, line) => `Line ${line + 1} of a pasted plan`).join("\n");

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
interface Seen {
  card: Box;
  // The field's text box, and each word it shows.
  words: Box;
  lines: Box[];
  scrolled: number;
  row: Box[];
  // dot's live line and dot itself, while either is drawn.
  dot: Box[];
  folding: boolean;
}

// Reads each frame once it is laid out and the page's own resize observers have run, as it is drawn:
// a sentinel resized every frame calls an observer made after the page's.
function watch(card: Locator) {
  return card.evaluate((form) => {
    const field = form.querySelector("textarea");
    if (!field) throw new Error("No field");
    const box = ({ top, bottom, left, right }: Box) => ({ top, bottom, left, right });
    const shown = (element: Element) => {
      let opacity = 1;
      for (let at: Element | null = element; at && at !== form; at = at.parentElement)
        opacity *= Number(getComputedStyle(at).opacity);
      return element.getClientRects().length > 0 && opacity > 0.01;
    };
    // The words the field shows, from a copy laid out as it is, the placeholder when it is empty.
    const copy = document.createElement("div");
    copy.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none";
    const lines = (outer: DOMRect, style: CSSStyleDeclaration) => {
      for (const name of [
        "box-sizing",
        "width",
        "font",
        "letter-spacing",
        "word-spacing",
        "text-indent",
        "text-transform",
        "tab-size",
        "white-space",
        "word-break",
        "overflow-wrap",
        "padding",
        "border-width",
        "border-style",
      ])
        copy.style.setProperty(name, style.getPropertyValue(name));
      const text = document.createTextNode(field.value || field.placeholder);
      copy.replaceChildren(text);
      document.body.append(copy);
      const origin = copy.getBoundingClientRect();
      const range = document.createRange();
      // Word by word: the space a line breaks at hangs past its end and draws nothing.
      const found = [...(text.data.matchAll(/\S+/g) ?? [])].flatMap((word) => {
        range.setStart(text, word.index);
        range.setEnd(text, word.index + word[0].length);
        return [...range.getClientRects()].map((part) => ({
          top: part.top - origin.top + outer.top - field.scrollTop,
          bottom: part.bottom - origin.top + outer.top - field.scrollTop,
          left: part.left - origin.left + outer.left,
          right: part.right - origin.left + outer.left,
        }));
      });
      copy.remove();
      return found;
    };
    const read = (): Seen => {
      const outer = field.getBoundingClientRect();
      const style = getComputedStyle(field);
      const [top, right, bottom, left] = [
        style.paddingTop,
        style.paddingRight,
        style.paddingBottom,
        style.paddingLeft,
      ].map(Number.parseFloat) as [number, number, number, number];
      const start = outer.top + field.clientTop + top;
      const side = outer.left + field.clientLeft + left;
      const words = {
        top: start,
        bottom: start + field.clientHeight - top - bottom,
        left: side,
        right: side + field.clientWidth - left - right,
      };
      return {
        card: box(form.getBoundingClientRect()),
        words,
        lines: lines(outer, style).filter(
          (line) => line.bottom > words.top && line.top < words.bottom,
        ),
        scrolled: field.scrollTop,
        row: [...form.querySelectorAll(".composer-model, .composer-permissions")]
          .filter(shown)
          .map((control) => box(control.getBoundingClientRect())),
        dot: [
          ...document.querySelectorAll(
            ".dot-strip:not([data-hidden]), .presence-frame[data-shown]",
          ),
        ]
          .filter((element) => getComputedStyle(element).visibility === "visible")
          .map((element) => box(element.getBoundingClientRect()))
          .filter((found) => found.bottom > found.top),
        folding: form.getAnimations().some((motion) => !(motion instanceof CSSTransition)),
      };
    };
    const seen: Seen[] = [];
    const sentinel = document.createElement("div");
    sentinel.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
    document.body.append(sentinel);
    const observer = new ResizeObserver(() => seen.push(read()));
    observer.observe(sentinel);
    let wide = false;
    let frame = 0;
    const tick = () => {
      wide = !wide;
      sentinel.style.width = wide ? "2px" : "1px";
      frame = requestAnimationFrame(tick);
    };
    tick();
    (window as unknown as { folding: () => Seen[] }).folding = () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      sentinel.remove();
      return seen;
    };
  });
}

async function frames(page: Page, card: Locator, act: () => Promise<unknown>) {
  await watch(card);
  await act();
  await page.waitForTimeout(700);
  return page.evaluate(() => (window as unknown as { folding: () => Seen[] }).folding());
}

const overlap = (a: Box, b: Box) =>
  a.top < b.bottom - 0.5 &&
  a.bottom > b.top + 0.5 &&
  a.left < b.right - 0.5 &&
  a.right > b.left + 0.5;

// Every frame where the words leave the card or meet the row, dot or its line meets the card, or the
// field has scrolled though the card already has the height it comes to rest at.
function faults(seen: Seen[]) {
  const rest = seen.at(-1);
  if (!rest) return ["no frames"];
  const restHeight = rest.card.bottom - rest.card.top;
  const out: string[] = [];
  seen.forEach(({ card, words, lines, scrolled, row, dot }, index) => {
    const at = `frame ${index}: words ${JSON.stringify(words)}, card ${JSON.stringify(card)}`;
    if (words.top < card.top - 0.5 || words.bottom > card.bottom + 0.5)
      out.push(`${at}: above or below the card`);
    for (const line of lines)
      if (line.left < card.left - 0.5 || line.right > card.right + 0.5)
        out.push(`${at}: a word beside the card, ${JSON.stringify(line)}`);
    for (const control of row)
      if (overlap(words, control)) out.push(`${at}: over the row at ${JSON.stringify(control)}`);
    for (const over of dot)
      if (overlap(over, card)) out.push(`${at}: dot over the card at ${JSON.stringify(over)}`);
    if (scrolled > 0 && rest.scrolled === 0 && card.bottom - card.top >= restHeight - 0.5)
      out.push(`${at}: scrolled ${scrolled}`);
  });
  return out;
}

// The card's top, frame by frame, while it folds or opens and as it comes to rest: how many frames it
// moves in, which ways, and its largest step as a share of the whole way. A line that wraps once it is
// open grows it at once, as it always does, and is not part of the glide.
function motion(seen: Seen[]) {
  const steps = seen
    .slice(1)
    .map((frame, index) => {
      const before = seen[index] ?? frame;
      return before.folding || frame.folding ? frame.card.top - before.card.top : 0;
    })
    .filter((step) => Math.abs(step) > 0.25);
  const way = Math.abs(steps.reduce((sum, step) => sum + step, 0));
  return {
    frames: steps.length,
    directions: new Set(steps.map(Math.sign)).size,
    largest: Math.max(0, ...steps.map(Math.abs)) / (way || 1),
  };
}

async function paste(field: Locator, text: string) {
  await field.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

// Nothing in the card moving, so the next frames start from rest.
async function settled(card: Locator) {
  await expect
    .poll(() =>
      card.evaluate(
        (form) =>
          form.getAnimations({ subtree: true }).filter((motion) => motion.playState === "running")
            .length,
      ),
    )
    .toBe(0);
}

// A tap on the thread, which takes focus from the field without being in the composer.
async function leave(page: Page) {
  const thread = page.locator(".thread-scroll").first();
  const box = await thread.boundingBox();
  await thread.click({ position: { x: 12, y: (box?.height ?? 0) / 2 } });
}

// As iOS does when the keyboard comes up: the visual viewport shrinks under the page.
const keyboard = (page: Page, covered: number) =>
  page.evaluate((covered) => {
    const view = window.visualViewport;
    if (!view) throw new Error("Visual viewport required");
    Object.defineProperty(view, "height", {
      configurable: true,
      value: window.innerHeight - covered,
    });
    view.dispatchEvent(new Event("resize"));
  }, covered);

type Way = (page: Page, field: Locator) => Promise<unknown>;
// Whether the card's growth is judged too: typing may hold the page's frames back, and its line may
// wrap after the card has opened, which grows it at once as it always does; six lines landing before
// the card has opened are more than it holds yet, and it makes room for them at once.
const ways: [string, Way, boolean][] = [
  [
    "typed",
    async (page, field) => {
      await field.click();
      await page.keyboard.type(MESSAGE, { delay: 4 });
    },
    false,
  ],
  [
    "pasted",
    async (_, field) => {
      await field.click();
      await paste(field, MESSAGE);
    },
    true,
  ],
  ["filled", (_, field) => field.fill(MESSAGE), true],
  [
    "a long paste",
    async (_, field) => {
      await field.click();
      await paste(field, LONG);
    },
    false,
  ],
];

async function open(page: Page, ui: { open: (scenario: "running") => Promise<unknown> }) {
  if (isPhone(page)) await page.setViewportSize({ width: 402, height: 874 });
  await ui.open("running");
  await expect(page.locator(".app")).not.toHaveAttribute("data-entering");
  // Chat beside its list, on a desktop, has no rail.
  if ((await page.locator(".phone-stack").count()) > 0)
    return page.locator(".phone-chat").getByRole("form", { name: "Message dot" });
  return composer(page);
}

async function check(
  page: Page,
  card: Locator,
  name: string,
  act: () => Promise<unknown>,
  judged: boolean,
) {
  await settled(card);
  await expect(card).toHaveAttribute("data-compact", "");
  const opening = await frames(page, card, act);
  await expect(card).not.toHaveAttribute("data-compact");
  expect.soft(faults(opening), `${name}: opening`).toEqual([]);
  const opened = motion(opening);
  expect.soft(opened.directions, `${name}: one direction`).toBeLessThanOrEqual(1);
  if (!judged) return;
  expect.soft(opened.frames, `${name}: frames the card moved in`).toBeGreaterThan(2);
  expect.soft(opened.largest, `${name}: largest step, of the way`).toBeLessThan(1 / 3);
}

async function fold(page: Page, card: Locator, name: string) {
  const field = card.getByRole("textbox").first();
  // Deleting back to empty keeps it open while the field has focus; leaving folds it.
  await field.press("ControlOrMeta+a");
  await field.press("Backspace");
  await expect(field).toHaveValue("");
  await settled(card);
  await expect(card).not.toHaveAttribute("data-compact");
  const closing = await frames(page, card, () => leave(page));
  await expect(card).toHaveAttribute("data-compact", "");
  expect.soft(faults(closing), `${name}: closing`).toEqual([]);
  const closed = motion(closing);
  expect.soft(closed.directions, `${name}: closing, one direction`).toBe(1);
  expect.soft(closed.largest, `${name}: closing, largest step, of the way`).toBeLessThan(1 / 3);
}

for (const view of ["studio", "chat"] as ViewStyle[]) {
  test.describe(`${view}`, () => {
    test.use({ viewStyle: view });

    test("opening and folding keep the words in the card and clear of the row", async ({
      page,
      ui,
    }) => {
      const card = await open(page, ui);
      const field = card.getByRole("textbox").first();
      for (const [name, act, judged] of ways) {
        await check(page, card, name, () => act(page, field), judged);
        await page.screenshot({ path: test.info().outputPath(`${name}-open.png`) });
        await fold(page, card, name);
      }
    });

    test("the keyboard coming up while it opens", async ({ page, ui }) => {
      test.skip(!isPhone(page), "A phone's keyboard");
      const card = await open(page, ui);
      const field = card.getByRole("textbox").first();
      await check(
        page,
        card,
        "keyboard",
        async () => {
          await field.click();
          await keyboard(page, 310);
          await page.keyboard.type(MESSAGE, { delay: 4 });
        },
        false,
      );
      // It rides on the keyboard.
      await expect
        .poll(async () => Math.round((await card.boundingBox())?.y ?? 0))
        .toBeLessThan(874 - 310 - 60);
      await page.screenshot({ path: test.info().outputPath("keyboard-open.png") });
      await keyboard(page, 0);
      await fold(page, card, "keyboard");
    });
  });
}

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("it opens at once, with the words in place", async ({ page, ui }) => {
    const card = await open(page, ui);
    const opening = await frames(page, card, () => card.getByRole("textbox").first().fill(MESSAGE));
    expect(faults(opening)).toEqual([]);
    expect(opening.some((frame) => frame.folding)).toBe(false);
  });
});
