// biome-ignore-all lint/suspicious/noArrayIndexKey: A page has no identity but its number.
import "@localdot/protocol/csp";
import { VIEWER_LIMITS } from "@localdot/protocol";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
  TextLayer,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.ts";
import { IconButton } from "../../ui/IconButton.tsx";
import { PHONE, useMediaQuery } from "../../ui/media.ts";
import { ThumbnailButton } from "../../ui/Thumbnail.tsx";
import { loadPreviewBytes } from "../api.ts";
import { ViewerBar, ViewerLoading, ViewerMessage } from "./states.tsx";

GlobalWorkerOptions.workerSrc = workerUrl;

// A page is never drawn larger than this many device pixels.
const MAX_PIXELS = 16_000_000;
const MAX_WIDTH = 920;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const THUMB_WIDTH = 96;

interface Doc {
  pdf: PDFDocumentProxy;
  // Width over height of each page, as known so far; the first page's until a page is drawn.
  ratios: number[];
}

// A PDF drawn by pdf.js in this page: every page in one scroll, its text selectable, thumbnails
// beside it on a wide screen. Nothing in the file runs: no scripts, forms or links are drawn.
export function PdfView({ api, url, name }: { api: ApiClient; url: string; name: string }) {
  const [doc, setDoc] = useState<Doc | "locked" | "failed" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let task: PDFDocumentLoadingTask | undefined;
    (async () => {
      const data = await loadPreviewBytes(api, url, VIEWER_LIMITS.pdfBytes, controller.signal);
      task = getDocument({
        data: new Uint8Array(data),
        enableXfa: false,
        useWasm: false,
        stopAtErrors: false,
        maxImageSize: 50_000_000,
      });
      const pdf = await task.promise;
      const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
      if (!controller.signal.aborted)
        setDoc({ pdf, ratios: Array(pdf.numPages).fill(first.width / first.height) });
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setDoc((error as { name?: string })?.name === "PasswordException" ? "locked" : "failed");
    });
    return () => {
      controller.abort();
      void task?.destroy();
    };
  }, [api, url]);
  if (doc === null) return <ViewerLoading label="Loading the PDF" />;
  if (doc === "locked")
    return (
      <ViewerMessage name={name} title="This PDF is locked">
        It needs a password. Download it to open it.
      </ViewerMessage>
    );
  if (doc === "failed")
    return (
      <ViewerMessage name={name} title="Can't show this PDF">
        It may be damaged. Download it to open it in another app.
      </ViewerMessage>
    );
  return <Pages doc={doc} />;
}

function Pages({ doc }: { doc: Doc }) {
  const phone = useMediaQuery(PHONE);
  const scroller = useRef<HTMLDivElement>(null);
  const [column, setColumn] = useState(0);
  const [zoom, setZoom] = useState(2);
  const [current, setCurrent] = useState(1);
  const [ratios, setRatios] = useState(doc.ratios);
  const count = doc.pdf.numPages;
  useLayoutEffect(() => {
    const host = scroller.current;
    if (!host) return;
    const measure = () => setColumn(host.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  const fitWidth = Math.max(160, Math.min(MAX_WIDTH, column - (phone ? 24 : 64)));
  const width = Math.round(fitWidth * (ZOOMS[zoom] ?? 1));
  const sized = (page: number, ratio: number) =>
    setRatios((was) =>
      Math.abs((was[page - 1] ?? 0) - ratio) < 0.001
        ? was
        : was.map((r, i) => (i === page - 1 ? ratio : r)),
    );
  const show = (page: number) => {
    scroller.current
      ?.querySelector(`[data-page="${page}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  // The page across the middle of the view is the one being read.
  useEffect(() => {
    const host = scroller.current;
    if (!host || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting)
            setCurrent(Number((entry.target as HTMLElement).dataset.page) || 1);
      },
      { root: host, rootMargin: "-50% 0px -50% 0px" },
    );
    for (const page of host.querySelectorAll("[data-page]")) observer.observe(page);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <ViewerBar
        note={
          <span className="num" aria-live="polite">
            Page {current} of {count}
          </span>
        }
      >
        <div className="viewer-zoom">
          <IconButton
            icon="minus"
            size={28}
            label="Zoom out"
            disabledReason={zoom === 0 ? "Zoomed out all the way" : undefined}
            onClick={() => setZoom((z) => Math.max(0, z - 1))}
          />
          <span className="viewer-zoom-value num">{Math.round((ZOOMS[zoom] ?? 1) * 100)}%</span>
          <IconButton
            icon="plus"
            size={28}
            label="Zoom in"
            disabledReason={zoom === ZOOMS.length - 1 ? "Zoomed in all the way" : undefined}
            onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}
          />
        </div>
      </ViewerBar>
      <div className="viewer-stage viewer-pdf">
        {!phone && count > 1 && (
          <nav className="viewer-thumbs" aria-label="Pages">
            {Array.from({ length: count }, (_, i) => (
              <div key={i} className="viewer-thumb">
                <ThumbnailButton
                  label={`Page ${i + 1}`}
                  ratio={ratios[i]}
                  current={current === i + 1}
                  onClick={() => show(i + 1)}
                >
                  <PdfPage doc={doc} number={i + 1} width={THUMB_WIDTH} ratio={ratios[i] ?? 1} />
                </ThumbnailButton>
                <span className="viewer-thumb-number num">{i + 1}</span>
              </div>
            ))}
          </nav>
        )}
        <div ref={scroller} className="viewer-pages" tabIndex={-1}>
          {Array.from({ length: count }, (_, i) => (
            <div
              key={i}
              data-page={i + 1}
              className="viewer-paper"
              style={{ width, height: Math.round(width / (ratios[i] ?? 1)) }}
            >
              {column > 0 && (
                <PdfPage
                  doc={doc}
                  number={i + 1}
                  width={width}
                  ratio={ratios[i] ?? 1}
                  text
                  onRatio={(ratio) => sized(i + 1, ratio)}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// One page, drawn once it comes near the view and let go again far from it.
function PdfPage({
  doc,
  number,
  width,
  ratio,
  text = false,
  onRatio,
}: {
  doc: Doc;
  number: number;
  width: number;
  ratio: number;
  text?: boolean;
  onRatio?(ratio: number): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const art = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "1200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Far from the view a page lets its drawing go.
  useEffect(() => {
    if (near) return;
    art.current?.replaceChildren();
    layer.current?.replaceChildren();
  }, [near]);
  const ratioSeen = useRef(onRatio);
  ratioSeen.current = onRatio;
  useEffect(() => {
    if (!near) return;
    let task: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    let cancelled = false;
    (async () => {
      const page = await doc.pdf.getPage(number);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      ratioSeen.current?.(base.width / base.height);
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });
      const density = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height)),
      );
      // Drawn off to the side and swapped in whole, so a zoom never shows a blank page.
      const target = document.createElement("canvas");
      target.width = Math.floor(viewport.width * density);
      target.height = Math.floor(viewport.height * density);
      target.setAttribute("aria-hidden", "true");
      task = page.render({
        canvas: target,
        viewport,
        transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
      });
      await task.promise;
      if (cancelled) return;
      art.current?.replaceChildren(target);
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
    })().catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
    };
  }, [near, doc, number, width, text]);
  return (
    <div ref={host} className="viewer-page-art" data-ratio={ratio}>
      <div ref={art} className="viewer-page-canvas" />
      {text && <div ref={layer} className="viewer-pdf-text" />}
    </div>
  );
}
