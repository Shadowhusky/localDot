// Loaded on its own, so it names the schema setting the entries load first: it then shares their
// chunk, and no schema is built before it (zod would otherwise probe Function() against the CSP).
import "@localdot/protocol/csp";
import {
  canOpenOnMac,
  fileExtension,
  isPresentation,
  type TextFormat,
  textFormat,
  VIEWER_LIMITS,
  type ViewerKind,
  viewerKind,
} from "@localdot/protocol";
import {
  lazy,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { FileName, type ResultDownloads } from "../../agent/ResultFiles.tsx";
import { bytes } from "../../copy/format.ts";
import type { ApiClient } from "../../lib/api.ts";
import { Button } from "../../ui/Button.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { matches, REDUCED_MOTION } from "../../ui/media.ts";
import { SegmentedControl } from "../../ui/SegmentedControl.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { keptPreviewBase, previewBase, previewUrl } from "../api.ts";
import { openHere } from "../open-here.ts";
import { MediaView } from "./MediaView.tsx";
import { PageView } from "./PageView.tsx";
import { PictureView } from "./PictureView.tsx";
import { entryKey, type ShownVersion, type ViewerEntry } from "./scope.tsx";
import { ViewerLoading, ViewerMessage } from "./states.tsx";
import { TableView } from "./TableView.tsx";
import { TextView } from "./TextView.tsx";
import { viewerHears } from "./viewer-keys.ts";
import { rubberband, swipeTurn } from "./zoom.ts";
import "./viewer.css";

const PdfFile = lazy(() => import("./PdfView.tsx").then((module) => ({ default: module.PdfFile })));
const OfficePages = lazy(() =>
  import("./PdfView.tsx").then((module) => ({ default: module.OfficePages })),
);
const LARGE = ["large"] as const;
// Past these a file shows "Too large to preview"; text and tables show their start instead.
const CAPS: Partial<Record<ViewerKind, number>> = {
  picture: VIEWER_LIMITS.pictureBytes,
  svg: VIEWER_LIMITS.svgBytes,
  pdf: VIEWER_LIMITS.pdfBytes,
  html: VIEWER_LIMITS.htmlBytes,
  sheet: VIEWER_LIMITS.sheetBytes,
};
const TEXT_LABELS: Record<TextFormat, string> = {
  plain: "Text",
  code: "code",
  markdown: "Markdown",
  json: "JSON",
  log: "Log",
};
const LANGUAGES: Record<string, string> = {
  ...Object.fromEntries(["js", "mjs", "cjs", "jsx"].map((e) => [e, "JavaScript"])),
  ts: "TypeScript",
  tsx: "TypeScript",
  py: "Python",
  rb: "Ruby",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C header",
  cpp: "C++",
  cs: "C#",
  php: "PHP",
  ...Object.fromEntries(["sh", "bash", "zsh", "fish"].map((e) => [e, "Shell script"])),
  sql: "SQL",
  css: "Stylesheet",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
};

export function kindLabel(name: string): string {
  const ext = fileExtension(name).toUpperCase();
  const kind = viewerKind(name);
  if (kind === "text") {
    const format = textFormat(name);
    return format === "code"
      ? (LANGUAGES[ext.toLowerCase()] ?? `${ext} text`)
      : TEXT_LABELS[format];
  }
  const labels: Record<Exclude<ViewerKind, "text">, string> = {
    picture: `${ext} picture`,
    svg: "SVG picture",
    pdf: "PDF",
    html: "Web page",
    table: `${ext} table`,
    sheet: "Spreadsheet",
    audio: `${ext} audio`,
    video: `${ext} video`,
    page: isPresentation(name) ? `${ext} presentation` : `${ext} document`,
    details: ext ? `${ext} file` : "File",
  };
  return labels[kind];
}

interface Item {
  key: string;
  entry: ViewerEntry;
  name: string;
  sessionId: string;
  version: number | null;
  bytes: number;
  label?: number;
  // The file's own version, so a download needs no other.
  own: boolean;
}
function itemOf(entry: ViewerEntry, shown?: ShownVersion & { key: string }): Item {
  const key = entryKey(entry);
  const pick = shown?.key === key ? shown : undefined;
  const own = entry.file.version ?? null;
  return {
    key,
    entry,
    name: entry.file.name,
    sessionId: pick?.sessionId ?? entry.sessionId,
    version: pick ? pick.version : own,
    bytes: pick?.bytes ?? entry.file.bytes,
    label: pick?.label,
    own: !pick || (pick.sessionId === entry.sessionId && pick.version === own),
  };
}

// Whether something under `from` scrolls sideways in the direction a swipe would move it.
function scrollsAcross(from: EventTarget | null, dx: number, root: HTMLElement): boolean {
  for (let node = from as HTMLElement | null; node && node !== root; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth + 1) continue;
    const style = getComputedStyle(node).overflowX;
    if (style !== "auto" && style !== "scroll") continue;
    if (dx < 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 0)
      return true;
  }
  return false;
}

export interface FileViewerProps {
  api: ApiClient;
  entries: readonly ViewerEntry[];
  index: number;
  shown?: ShownVersion & { key: string };
  open: boolean;
  downloads: Pick<ResultDownloads, "state" | "busy" | "request" | "sessionId">;
  onMac: boolean;
  onIndex(next: number): void;
  onClose(): void;
}

// The full preview: the file large in a wide sheet (a full-height sheet on a phone), with the arrow
// keys, a swipe or the buttons moving between the files beside it, and Download and Open on Mac
// always in reach.
export function FileViewer({
  api,
  entries,
  index,
  shown,
  open,
  downloads,
  onMac,
  onIndex,
  onClose,
}: FileViewerProps) {
  const entry = entries[index] as ViewerEntry;
  const item = itemOf(entry, shown);
  const total = entries.length;
  const root = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState<{ key: string; from: -1 | 1 } | null>(null);
  const go = (step: -1 | 1) => {
    const next = index + step;
    if (next < 0 || next >= total) return;
    const key = entries[next] && entryKey(entries[next]);
    if (key) setEntered({ key, from: step });
    onIndex(next);
  };
  const latest = useRef(go);
  latest.current = go;

  // Left and right arrows move between files, unless what has focus uses them itself.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      const host = root.current;
      if (!host || !viewerHears(host, target)) return;
      const step = event.key === "ArrowLeft" ? -1 : 1;
      if (target && scrollsAcross(target, -step, host)) return;
      event.preventDefault();
      latest.current(step);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // A sideways swipe on a phone follows the finger, then turns to the file it was thrown towards.
  const swipe = useRef<{
    id: number;
    x: number;
    y: number;
    decided?: boolean;
    moves: { t: number; x: number }[];
  } | null>(null);
  const place = (dx: number | null) => {
    const element = pane.current;
    if (!element) return;
    element.toggleAttribute("data-dragging", dx !== null);
    element.style.transform = dx === null ? "" : `translateX(${dx}px)`;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || swipe.current) {
      if (swipe.current?.decided) place(null);
      swipe.current = null;
      return;
    }
    swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moves: [] };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    const host = root.current;
    if (!s || s.id !== event.pointerId || !host) return;
    const dx = event.clientX - s.x;
    const dy = event.clientY - s.y;
    if (!s.decided) {
      if (Math.hypot(dx, dy) < 10) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.5 || scrollsAcross(event.target, dx, host)) {
        swipe.current = null;
        return;
      }
      s.decided = true;
      host.setPointerCapture(event.pointerId);
    }
    s.moves = [...s.moves.slice(-5), { t: event.timeStamp, x: event.clientX }];
    const room = dx < 0 ? index < total - 1 : index > 0;
    place(room ? dx : rubberband(dx, host.clientWidth));
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    if (!s || s.id !== event.pointerId) return;
    swipe.current = null;
    if (!s.decided) return;
    const first = s.moves[0];
    const last = s.moves.at(-1);
    const velocity =
      first && last && last.t > first.t ? ((last.x - first.x) / (last.t - first.t)) * 1000 : 0;
    const turn =
      event.type === "pointercancel"
        ? 0
        : swipeTurn(event.clientX - s.x, velocity, root.current?.clientWidth ?? 390);
    place(null);
    if (turn !== 0) go(turn);
  };

  const state = downloads.state(entry.resultId, entry.file);
  const kind = viewerKind(item.name);
  // The arrows turn a document's own pages.
  const paged = kind === "pdf" || kind === "page";
  const meta = [kindLabel(item.name), bytes(item.bytes), item.label ? `v${item.label}` : null]
    .filter(Boolean)
    .join(" · ");
  const download = (
    <Button
      size="md"
      icon={state === "done" ? "check" : "download"}
      busy={state === "busy"}
      disabledReason={
        !downloads.sessionId
          ? "This task is no longer available."
          : downloads.busy && state !== "busy"
            ? "Another download is still running."
            : undefined
      }
      onClick={() =>
        void downloads.request(
          entry.resultId,
          entry.file,
          item.own ? undefined : { sessionId: item.sessionId, version: item.version },
        )
      }
    >
      Download
    </Button>
  );
  const footer = (
    <div className="viewer-footer">
      {total > 1 ? (
        <div className="viewer-nav">
          <IconButton
            icon="chevron-left"
            size={32}
            label="Previous file"
            kbd={paged ? undefined : ["←"]}
            disabledReason={index === 0 ? "This is the first file" : undefined}
            onClick={() => go(-1)}
          />
          <span className="viewer-count num">
            {index + 1} of {total}
          </span>
          <IconButton
            icon="chevron-right"
            size={32}
            label="Next file"
            kbd={paged ? undefined : ["→"]}
            disabledReason={index === total - 1 ? "This is the last file" : undefined}
            onClick={() => go(1)}
          />
        </div>
      ) : (
        <span />
      )}
      <div className="viewer-actions">
        {onMac && canOpenOnMac(item.name) && (
          <Button
            size="md"
            variant="secondary"
            onClick={() => void openHere(api, item.sessionId, item.name, item.version)}
          >
            Open on Mac
          </Button>
        )}
        {download}
      </div>
    </div>
  );
  const enteredFrom =
    entered?.key === item.key && !matches(REDUCED_MOTION) ? entered.from : undefined;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={<FileName name={item.name} />}
      description={meta}
      className="file-viewer"
      size="wide"
      modal
      flush
      detents={LARGE}
      footer={footer}
    >
      <div
        ref={root}
        className="viewer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <div
          ref={pane}
          key={`${item.key}/${item.sessionId}/${item.version ?? 0}`}
          className="viewer-pane"
          data-kind={kind}
          data-from={enteredFrom === 1 ? "right" : enteredFrom === -1 ? "left" : undefined}
        >
          <ViewBody api={api} item={item} kind={kind} download={download} />
        </div>
      </div>
    </Sheet>
  );
}

// A kept link shows the file at once; the daemon's answer replaces it if the daemon has restarted.
function usePreviewUrl(api: ApiClient, item: Item, wanted: boolean): string | null | "failed" {
  const [url, setUrl] = useState<{ key: string; url: string | "failed" } | null>(null);
  const key = `${item.sessionId}/${item.name}/${item.version ?? 0}`;
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    const show = (next: string) =>
      setUrl((was) => (was?.key === key && was.url === next ? was : { key, url: next }));
    const kept = keptPreviewBase(api, item.sessionId);
    if (kept) show(previewUrl(api, kept, item.name, item.version));
    previewBase(api, item.sessionId, controller.signal).then(
      (base) => !controller.signal.aborted && show(previewUrl(api, base, item.name, item.version)),
      () => !controller.signal.aborted && !kept && show("failed"),
    );
    return () => controller.abort();
  }, [api, item.sessionId, item.name, item.version, key, wanted]);
  return url?.key === key ? url.url : null;
}

function ViewBody({
  api,
  item,
  kind,
  download,
}: {
  api: ApiClient;
  item: Item;
  kind: ViewerKind;
  download: React.ReactNode;
}) {
  const cap = CAPS[kind];
  const tooLarge = cap !== undefined && item.bytes > cap;
  const drawn = ["picture", "svg", "pdf", "html", "audio", "video"].includes(kind);
  const url = usePreviewUrl(api, item, drawn && !tooLarge);
  const { name, sessionId, version } = item;
  if (tooLarge)
    return (
      <ViewerMessage name={name} title="Too large to preview" action={download}>
        {bytes(item.bytes)} is more than this preview opens.
      </ViewerMessage>
    );
  if (url === "failed") return <ViewerMessage name={name} title="Couldn't load the preview" />;
  if (kind === "text")
    return <TextView api={api} sessionId={sessionId} name={name} version={version} />;
  if (kind === "table")
    return <TableView api={api} sessionId={sessionId} name={name} version={version} />;
  if (kind === "sheet")
    return <SheetView api={api} sessionId={sessionId} name={name} version={version} />;
  if (kind === "page")
    return (
      <Suspense fallback={<ViewerLoading label="Loading the pages" />}>
        <OfficePages api={api} sessionId={sessionId} name={name} version={version} />
      </Suspense>
    );
  if (kind === "html")
    return <PageView api={api} url={url} sessionId={sessionId} name={name} version={version} />;
  if (kind === "details")
    return (
      <ViewerMessage name={name} title="No preview for this kind of file">
        {kindLabel(name)} · {bytes(item.bytes)}
      </ViewerMessage>
    );
  if (url === null) return <ViewerLoading label="Loading the preview" />;
  if (kind === "pdf")
    return (
      <Suspense fallback={<ViewerLoading label="Loading the PDF" />}>
        <PdfFile key={url} api={api} url={url} name={name} />
      </Suspense>
    );
  if (kind === "audio" || kind === "video")
    return <MediaView key={url} url={url} kind={kind} name={name} />;
  return <PictureView key={url} src={url} name={name} />;
}

// A workbook as its table, or as the pages it would print on, which dot's computer makes.
function SheetView(props: {
  api: ApiClient;
  sessionId: string;
  name: string;
  version: number | null;
}) {
  const [shown, setShown] = useState("table");
  const lead = (
    <SegmentedControl
      size={28}
      aria-label="Show"
      value={shown}
      items={[
        { value: "table", label: "Table" },
        { value: "pages", label: "Pages" },
      ]}
      onValueChange={setShown}
    />
  );
  if (shown === "table") return <TableView {...props} lead={lead} />;
  return (
    <Suspense fallback={<ViewerLoading label="Loading the pages" />}>
      <OfficePages {...props} lead={lead} />
    </Suspense>
  );
}
