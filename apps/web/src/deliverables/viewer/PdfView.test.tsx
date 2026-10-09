// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../../lib/api.ts";
import { FileViewer } from "./FileViewer.tsx";
import { PdfPage } from "./PdfPage.tsx";
import type { ViewerEntry } from "./scope.tsx";

const opening = vi.hoisted(() => ({ pdf: null as unknown }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: Promise.resolve(opening.pdf), destroy: async () => {} }),
  TextLayer: class {
    render = async () => {};
    cancel() {}
  },
}));

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const RESULT = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0R";

function fakePdf(count: number, size = { w: 612, h: 792 }) {
  const pages = new Map<number, { render: ReturnType<typeof vi.fn>; cleanup: () => boolean }>();
  const getPage = async (n: number) => {
    const page = pages.get(n) ?? {
      getViewport: ({ scale }: { scale: number }) => ({
        width: size.w * scale,
        height: size.h * scale,
      }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel() {} })),
      cleanup: vi.fn(() => true),
      streamTextContent: () => ({}),
    };
    pages.set(n, page);
    return page;
  };
  return { pdf: { numPages: count, getPage } as unknown as PDFDocumentProxy, pages };
}

// jsdom lays nothing out: every box is 900 by 700, and the pages' column as wide as `wide`.
let wide = 900;
const layout: Record<string, PropertyDescriptor> = {
  clientWidth: { get: () => 900 },
  clientHeight: { get: () => 700 },
  scrollWidth: {
    get(this: HTMLElement) {
      return this.classList.contains("viewer-pages") ? wide : 900;
    },
  },
  scrollTo: {
    value(this: HTMLElement, to: ScrollToOptions) {
      if (to.top !== undefined) this.scrollTop = to.top;
    },
  },
  scrollBy: {
    value(this: HTMLElement, by: ScrollToOptions) {
      this.scrollTop += by.top ?? 0;
      this.scrollLeft = Math.min(this.scrollWidth - 900, this.scrollLeft + (by.left ?? 0));
    },
  },
};
beforeEach(() => {
  wide = 900;
  for (const [name, descriptor] of Object.entries(layout))
    Object.defineProperty(HTMLElement.prototype, name, { ...descriptor, configurable: true });
});
afterEach(() => {
  cleanup();
  for (const name of Object.keys(layout))
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
});

function viewer(name: string, pdf: PDFDocumentProxy) {
  opening.pdf = pdf;
  const api = createApi("a".repeat(43), {
    origin: "http://127.0.0.1:4750",
    fetchImpl: async (url) => {
      const { pathname } = new URL(String(url));
      if (pathname.endsWith("/preview-link"))
        return Response.json({ base: `/file-previews/${"t".repeat(43)}/` });
      return new Response("%PDF-1.7");
    },
  });
  const entries: ViewerEntry[] = [name, "next.zip"].map((file) => ({
    resultId: RESULT,
    sessionId: ID,
    file: { name: file, path: `Documents/${file}`, bytes: 100, version: 1 },
  }));
  const onIndex = vi.fn();
  render(
    <FileViewer
      api={api}
      entries={entries}
      index={0}
      open
      downloads={{ state: () => undefined, busy: false, request: async () => true, sessionId: ID }}
      onMac={false}
      onIndex={onIndex}
      onClose={() => {}}
    />,
  );
  return { onIndex };
}
const papers = () =>
  [...document.querySelectorAll<HTMLElement>(".viewer-paper")].map((p) => Number(p.dataset.page));
const field = (noun: string, count: number) =>
  screen.findByRole<HTMLInputElement>("textbox", { name: `${noun} number, of ${count}` });

describe("a PDF in the full preview", () => {
  it("turns its pages with the keys instead of moving to the next file, and mounts only the pages near the view", async () => {
    const { onIndex } = viewer("handbook.pdf", fakePdf(300).pdf);
    const page = await field("Page", 300);
    await waitFor(() => expect(papers()).toContain(1));
    expect(papers().length).toBeLessThanOrEqual(8);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(page.value).toBe("2");
    expect(onIndex).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "End" });
    expect(page.value).toBe("300");
    fireEvent.scroll(document.querySelector(".viewer-pages") as HTMLElement);
    await waitFor(() => expect(papers()).toContain(300));
    expect(papers().length).toBeLessThanOrEqual(8);
    expect(Math.min(...papers())).toBeGreaterThan(290);
  });

  it("scrolls a page zoomed wider than the column across with the side arrows, never away", async () => {
    const { onIndex } = viewer("handbook.pdf", fakePdf(300).pdf);
    const page = await field("Page", 300);
    wide = 1800;
    const host = document.querySelector(".viewer-pages") as HTMLElement;
    expect(fireEvent.keyDown(document.body, { key: "ArrowRight" })).toBe(false);
    expect(host.scrollLeft).toBe(48);
    host.scrollLeft = 900;
    fireEvent.keyDown(host, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(host.scrollLeft).toBe(852);
    expect(page.value).toBe("1");
    expect(onIndex).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "PageDown" });
    expect(page.value).toBe("2");
  });

  it("leaves Space to a focused button", async () => {
    viewer("handbook.pdf", fakePdf(300).pdf);
    const page = await field("Page", 300);
    const zoom = screen.getByRole("button", { name: "Zoom in" });
    act(() => zoom.focus());
    expect(fireEvent.keyDown(zoom, { key: " " })).toBe(true);
    const thumb = await screen.findByRole("button", { name: "Page 5" });
    act(() => thumb.focus());
    expect(fireEvent.keyDown(thumb, { key: " " })).toBe(true);
    expect(page.value).toBe("1");
  });

  it("turns a deck's slides with the keys, but Space presses a focused Present", async () => {
    const { onIndex } = viewer("deck.pdf", fakePdf(12, { w: 1280, h: 720 }).pdf);
    const slide = await field("Slide", 12);
    const present = screen.getByRole("button", { name: "Present" });
    act(() => present.focus());
    expect(fireEvent.keyDown(present, { key: " " })).toBe(true);
    expect(slide.value).toBe("1");
    act(() => present.blur());
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(slide.value).toBe("2");
    expect(onIndex).not.toHaveBeenCalled();
  });
});

describe("a drawn page", () => {
  it("lets pdf.js free what it drew once the page leaves, but keeps it across a zoom", async () => {
    const { pdf, pages } = fakePdf(3);
    const view = render(<PdfPage pdf={pdf} number={2} width={300} />);
    await waitFor(() => expect(pages.get(2)?.render).toHaveBeenCalledOnce());
    view.rerender(<PdfPage pdf={pdf} number={2} width={600} />);
    await waitFor(() => expect(pages.get(2)?.render).toHaveBeenCalledTimes(2));
    expect(pages.get(2)?.cleanup).not.toHaveBeenCalled();
    view.rerender(<PdfPage pdf={pdf} number={3} width={600} />);
    expect(pages.get(2)?.cleanup).toHaveBeenCalledOnce();
    await waitFor(() => expect(pages.get(3)?.render).toHaveBeenCalledOnce());
    view.unmount();
    expect(pages.get(3)?.cleanup).toHaveBeenCalledOnce();
  });
});
