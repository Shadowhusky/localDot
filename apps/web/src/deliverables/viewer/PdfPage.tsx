import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import { useEffect, useRef } from "react";

// A page is never drawn larger than this many device pixels, so a deep zoom stays within memory.
const MAX_PIXELS = 8_000_000;

// A page's printed size in points, from its first drawing.
export interface PageSize {
  w: number;
  h: number;
}

// A canvas gives its memory back at once only when shrunk to nothing; Safari otherwise holds it.
function release(canvas: Element | null | undefined) {
  if (!(canvas instanceof HTMLCanvasElement)) return;
  canvas.width = 0;
  canvas.height = 0;
}

// One page drawn at `width` CSS px, off to the side and swapped in whole, so a zoom never shows a
// blank page. A thumbnail waits a moment first, so a fast scroll past it draws nothing. Nothing in
// the file runs: no scripts, forms or links are drawn; text can be laid over it to select.
export function PdfPage({
  pdf,
  number,
  width,
  text = false,
  wait = 0,
}: {
  pdf: PDFDocumentProxy;
  number: number;
  width: number;
  text?: boolean;
  wait?: number;
}) {
  const art = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const drawn = useRef<PDFPageProxy | null>(null);
  useEffect(() => {
    let task: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    let cancelled = false;
    const draw = async () => {
      const page = await pdf.getPage(number);
      if (cancelled) return;
      drawn.current = page;
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });
      const density = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height)),
      );
      const target = document.createElement("canvas");
      target.width = Math.floor(viewport.width * density);
      target.height = Math.floor(viewport.height * density);
      target.setAttribute("aria-hidden", "true");
      task = page.render({
        canvas: target,
        viewport,
        transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
      });
      try {
        await task.promise;
      } catch (error) {
        release(target);
        throw error;
      }
      if (cancelled) return release(target);
      const was = art.current?.firstElementChild;
      art.current?.replaceChildren(target);
      if (was !== target) release(was);
      const container = layer.current;
      if (!text || !container) return;
      container.replaceChildren();
      container.style.setProperty("--total-scale-factor", String(scale));
      textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport,
      });
      await textLayer.render();
    };
    const timer = window.setTimeout(() => void draw().catch(() => {}), wait);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
      textLayer?.cancel();
    };
  }, [pdf, number, width, text, wait]);
  // pdf.js holds a drawn page's instructions and decoded pictures until told to let them go: kept
  // across a zoom, let go once this page leaves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lets go of the page drawn before either changes
  useEffect(
    () => () => {
      drawn.current?.cleanup();
      drawn.current = null;
    },
    [pdf, number],
  );
  useEffect(() => {
    const host = art.current;
    return () => release(host?.firstElementChild);
  }, []);
  return (
    <div className="viewer-page-art">
      <div ref={art} className="viewer-page-canvas" />
      {text && <div ref={layer} className="viewer-pdf-text" />}
    </div>
  );
}
