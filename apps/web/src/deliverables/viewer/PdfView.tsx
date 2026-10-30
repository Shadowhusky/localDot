import "@localdot/protocol/csp";
import { type PreviewReason, VIEWER_LIMITS } from "@localdot/protocol";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type ReactNode, useEffect, useState } from "react";
import type { ApiClient } from "../../lib/api.ts";
import { Button } from "../../ui/Button.tsx";
import { type KeptFile, type LoadedPages, loadPages, loadPreviewBytes } from "../api.ts";
import { PagesView } from "./PagesView.tsx";
import type { PageSize } from "./PdfPage.tsx";
import { modeFor } from "./paging.ts";
import { SlidesView } from "./SlidesView.tsx";
import { ViewerBar, ViewerLoading, ViewerMessage } from "./states.tsx";

GlobalWorkerOptions.workerSrc = workerUrl;

// Page sizes are read this many at a time after the first page shows, between frames.
const SIZES_AT_ONCE = 32;
const RETRY = new Set<PreviewReason>(["busy", "failed", "computer_off"]);
const PAGES_REASONS: Record<PreviewReason, string> = {
  attachment: "This kind of file has no pages to show.",
  binary: "This kind of file has no pages to show.",
  too_large: "It's too large to show here. Download it to open it.",
  computer_off: "Turn on your computer to see its pages.",
  busy: "Your computer is busy. Try again in a moment.",
  failed: "Your computer couldn't open it. Download it to open it in another app.",
  missing: "This version is no longer available.",
};

// A PDF the browser loads by its preview link.
export function PdfFile({ api, url, name }: { api: ApiClient; url: string; name: string }) {
  const [data, setData] = useState<ArrayBuffer | "failed" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    loadPreviewBytes(api, url, VIEWER_LIMITS.pdfBytes, controller.signal).then(
      (bytes) => !controller.signal.aborted && setData(bytes),
      () => !controller.signal.aborted && setData("failed"),
    );
    return () => controller.abort();
  }, [api, url]);
  if (data === null) return <ViewerLoading label="Loading the PDF" />;
  if (data === "failed") return <ViewerMessage name={name} title="Couldn't load the preview" />;
  return <PdfView data={data} name={name} />;
}

// An office document, deck or workbook as the PDF dot's computer makes of it: a minute or so the
// first time for a long deck, then at once for that version.
export function OfficePages(props: { api: ApiClient; file: KeptFile; lead?: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  return <OfficeAttempt key={attempt} {...props} retry={() => setAttempt((n) => n + 1)} />;
}

function OfficeAttempt({
  api,
  file,
  lead,
  retry,
}: {
  api: ApiClient;
  file: KeptFile;
  lead?: ReactNode;
  retry(): void;
}) {
  const { sessionId, name, version } = file;
  const [loaded, setLoaded] = useState<LoadedPages | "failed" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    loadPages(api, { sessionId, name, version }, controller.signal).then(
      (pages) => !controller.signal.aborted && setLoaded(pages),
      () => !controller.signal.aborted && setLoaded("failed"),
    );
    return () => controller.abort();
  }, [api, sessionId, name, version]);
  if (loaded !== null && loaded !== "failed" && loaded.kind === "pdf")
    return <PdfView data={loaded.data} name={name} lead={lead} />;
  const reason: PreviewReason = loaded === "failed" || loaded === null ? "failed" : loaded.reason;
  return (
    <>
      <ViewerBar>{lead}</ViewerBar>
      {loaded === null ? (
        <ViewerLoading label="Making the pages" note="Making the pages on your computer" />
      ) : (
        <ViewerMessage
          name={name}
          title="Can't show the pages"
          action={
            RETRY.has(reason) ? (
              <Button size="md" variant="secondary" onClick={retry}>
                Try again
              </Button>
            ) : undefined
          }
        >
          {PAGES_REASONS[reason]}
        </ViewerMessage>
      )}
    </>
  );
}

interface Opened {
  pdf: PDFDocumentProxy;
  first: PageSize;
}

// A PDF drawn by pdf.js in this page, a slide at a time for a deck and as pages otherwise. Nothing
// in the file runs: no scripts, forms or links are drawn.
export function PdfView({
  data,
  name,
  lead,
}: {
  data: ArrayBuffer;
  name: string;
  lead?: ReactNode;
}) {
  const [opened, setOpened] = useState<Opened | "locked" | "failed" | null>(null);
  useEffect(() => {
    let task: PDFDocumentLoadingTask | undefined;
    let gone = false;
    (async () => {
      // pdf.js hands the bytes to its worker; a copy leaves the caller's whole for a later opening.
      task = getDocument({
        data: new Uint8Array(data.slice(0)),
        enableXfa: false,
        useWasm: false,
        stopAtErrors: false,
        maxImageSize: 50_000_000,
      });
      const pdf = await task.promise;
      const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
      if (!gone) setOpened({ pdf, first: { w: first.width, h: first.height } });
    })().catch((error: unknown) => {
      if (gone) return;
      setOpened((error as { name?: string })?.name === "PasswordException" ? "locked" : "failed");
    });
    return () => {
      gone = true;
      void task?.destroy();
    };
  }, [data]);
  if (opened === null) return <ViewerLoading label="Loading the PDF" />;
  if (opened === "locked")
    return (
      <ViewerMessage name={name} title="This PDF is locked">
        It needs a password. Download it to open it.
      </ViewerMessage>
    );
  if (opened === "failed")
    return (
      <ViewerMessage name={name} title="Can't show this PDF">
        It may be damaged. Download it to open it in another app.
      </ViewerMessage>
    );
  return <Paged opened={opened} name={name} lead={lead} />;
}

function Paged({ opened, name, lead }: { opened: Opened; name: string; lead?: ReactNode }) {
  const sizes = useSizes(opened);
  return modeFor(name, opened.first.w / opened.first.h) === "slides" ? (
    <SlidesView pdf={opened.pdf} sizes={sizes} lead={lead} />
  ) : (
    <PagesView pdf={opened.pdf} sizes={sizes} lead={lead} />
  );
}

// Every page's size, the first page's standing in until each is read, a few at a time, so a long
// document lays out at once and settles as its odd-sized pages are found.
function useSizes({ pdf, first }: Opened): PageSize[] {
  const [sizes, setSizes] = useState<PageSize[]>(() => Array(pdf.numPages).fill(first));
  useEffect(() => {
    let stopped = false;
    (async () => {
      const found: PageSize[] = Array(pdf.numPages).fill(first);
      let changed = false;
      for (let n = 2; n <= pdf.numPages && !stopped; n++) {
        const view = (await pdf.getPage(n)).getViewport({ scale: 1 });
        const was = found[n - 1] as PageSize;
        if (Math.abs(view.width - was.w) > 0.5 || Math.abs(view.height - was.h) > 0.5) {
          found[n - 1] = { w: view.width, h: view.height };
          changed = true;
        }
        if (n % SIZES_AT_ONCE === 0 || n === pdf.numPages) {
          if (changed && !stopped) setSizes([...found]);
          changed = false;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }
    })().catch(() => {});
    return () => {
      stopped = true;
    };
  }, [pdf, first]);
  return sizes;
}
