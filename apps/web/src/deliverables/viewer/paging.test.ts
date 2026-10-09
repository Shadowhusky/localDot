import { describe, expect, it } from "vitest";
import {
  clampPage,
  contain,
  fittedWidth,
  indexAt,
  keyTurn,
  modeFor,
  nearby,
  readingPage,
  run,
  turned,
  typedPage,
  zoomStep,
} from "./paging.ts";

// 300 Letter pages 800 px wide: 1035 px each, 16 apart, 24 round the run.
const letter = run(Array(300).fill(800 / (612 / 792)), 16, 24);
const key = (k: string, more: Partial<KeyboardEvent> = {}) => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...more,
});

describe("laying pages out end to end", () => {
  it("places each page after the one before, with the gaps and padding counted once", () => {
    const r = run([100, 50, 200], 10, 20);
    expect(r.starts).toEqual([20, 130, 190]);
    expect(r.total).toBe(20 + 100 + 10 + 50 + 10 + 200 + 20);
    expect(run([], 10, 20).total).toBe(40);
  });

  it("finds the page at a point, the gap after a page counting as the next", () => {
    const r = run([100, 50, 200], 10, 20);
    expect([0, 20, 119, 120, 125, 130, 185, 400, 9_999].map((y) => indexAt(r, y))).toEqual([
      0, 0, 0, 0, 1, 1, 2, 2, 2,
    ]);
  });
});

describe("drawing only the pages near the view", () => {
  it("draws a handful of a 300-page PDF wherever it is scrolled to", () => {
    for (const top of [0, 50_000, letter.total - 900]) {
      const [first, last] = nearby(letter, top, 900, 900, 8);
      expect(last - first + 1).toBeLessThanOrEqual(4);
      expect(first).toBeLessThanOrEqual(indexAt(letter, top));
      expect(last).toBeGreaterThanOrEqual(indexAt(letter, top + 899));
    }
    expect(nearby(letter, 0, 900, 900, 8)[0]).toBe(0);
    expect(nearby(letter, letter.total - 900, 900, 900, 8)[1]).toBe(299);
  });

  it("never draws more than its limit when pages are small, keeping the page being read", () => {
    const tiny = run(Array(300).fill(40), 4, 8);
    const [first, last] = nearby(tiny, 4_000, 1_000, 1_000, 12);
    expect(last - first + 1).toBe(12);
    const reading = indexAt(tiny, 4_500);
    expect(first).toBeLessThanOrEqual(reading);
    expect(last).toBeGreaterThanOrEqual(reading);
  });

  it("draws nothing of an empty document", () => {
    expect(nearby(run([], 16, 24), 0, 900, 900, 8)).toEqual([0, -1]);
  });
});

describe("the page being read", () => {
  it("is the page across the upper part of the view", () => {
    expect(readingPage(letter, 0, 900)).toBe(1);
    expect(readingPage(letter, (letter.starts[11] ?? 0) - 200, 900)).toBe(12);
    expect(readingPage(letter, (letter.starts[11] ?? 0) - 400, 900)).toBe(11);
  });

  it("is the first page while the column has not been measured", () => {
    expect(readingPage(run(Array(12).fill(0), 16, 32), 0, 710)).toBe(1);
  });

  it("is the last page once the view reaches the end, however short that page is", () => {
    const r = run([1000, 1000, 120], 16, 24);
    expect(readingPage(r, r.total - 900, 900)).toBe(3);
    expect(readingPage(letter, letter.total - 900, 900)).toBe(300);
  });
});

describe("moving between pages", () => {
  it("turns a page, never past either end", () => {
    expect(turned(1, "previous", 24)).toBe(1);
    expect(turned(1, "next", 24)).toBe(2);
    expect(turned(24, "next", 24)).toBe(24);
    expect(turned(12, "first", 24)).toBe(1);
    expect(turned(3, "last", 24)).toBe(24);
    expect(clampPage(0, 0)).toBe(1);
  });

  it("goes to a typed page, clamped, and ignores anything that is not a number", () => {
    expect(typedPage("12", 300)).toBe(12);
    expect(typedPage(" 7 ", 300)).toBe(7);
    expect(typedPage("999", 300)).toBe(300);
    expect(typedPage("0", 300)).toBe(1);
    for (const text of ["", "1.5", "-3", "abc", "1e3", "12a"])
      expect(typedPage(text, 300), text).toBeUndefined();
  });

  it("turns pages with Page Up and Down and the side arrows, and leaves up and down to scrolling", () => {
    expect(keyTurn(key("PageDown"), "pages")).toBe("next");
    expect(keyTurn(key("PageUp"), "pages")).toBe("previous");
    expect(keyTurn(key("ArrowRight"), "pages")).toBe("next");
    expect(keyTurn(key("ArrowLeft"), "pages")).toBe("previous");
    expect(keyTurn(key("Home"), "pages")).toBe("first");
    expect(keyTurn(key("End"), "pages")).toBe("last");
    for (const k of ["ArrowDown", "ArrowUp", " ", "a"])
      expect(keyTurn(key(k), "pages")).toBeUndefined();
    expect(keyTurn(key("ArrowRight", { metaKey: true }), "pages")).toBeUndefined();
  });

  it("moves slides with every arrow and the space bar, Shift-Space going back", () => {
    expect(keyTurn(key("ArrowDown"), "slides")).toBe("next");
    expect(keyTurn(key(" "), "slides")).toBe("next");
    expect(keyTurn(key("ArrowUp"), "slides")).toBe("previous");
    expect(keyTurn(key(" ", { shiftKey: true }), "slides")).toBe("previous");
    expect(keyTurn(key("ArrowRight", { shiftKey: true }), "slides")).toBeUndefined();
  });
});

describe("how a file is shown", () => {
  it("shows decks as slides, landscape PDFs too, and everything else as pages", () => {
    expect(modeFor("review.pptx", 0.77)).toBe("slides");
    expect(modeFor("talk.odp", 1.78)).toBe("slides");
    expect(modeFor("export.pdf", 16 / 9)).toBe("slides");
    expect(modeFor("export.pdf", 4 / 3)).toBe("slides");
    expect(modeFor("handbook.pdf", 612 / 792)).toBe("pages");
    expect(modeFor("wide-table.xlsx", 1.41)).toBe("pages");
    expect(modeFor("brief.docx", 1.41)).toBe("pages");
  });

  it("fits a page across the column, or whole in the view", () => {
    const column = { w: 900, h: 700 };
    expect(fittedWidth("width", column, 0.77, 32)).toBe(836);
    expect(fittedWidth("page", column, 0.77, 32)).toBeCloseTo(636 * 0.77);
    expect(fittedWidth("page", column, 3, 32)).toBe(836);
  });

  it("fits a slide inside its stage keeping its shape", () => {
    expect(contain(16 / 9, { w: 1000, h: 1000 }, 20)).toEqual({ w: 960, h: 540 });
    expect(contain(16 / 9, { w: 1000, h: 400 }, 20)).toEqual({ w: 360 * (16 / 9), h: 360 });
  });

  it("zooms through the usual sizes from wherever it is", () => {
    expect(zoomStep(1, 1)).toBe(1.1);
    expect(zoomStep(1, -1)).toBe(0.9);
    expect(zoomStep(0.83, 1)).toBe(0.9);
    expect(zoomStep(0.83, -1)).toBe(0.75);
    expect(zoomStep(4, 1)).toBeUndefined();
    expect(zoomStep(0.25, -1)).toBeUndefined();
  });
});
