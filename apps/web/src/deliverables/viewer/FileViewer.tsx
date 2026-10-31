// Configure schemas before importing them: zod must not probe Function() against the CSP.
import "@localdot/protocol/csp";
import {
  type ComputerFileReply,
  canOpenOnMac,
  computerFileName,
  fileExtension,
  fileKind,
  isPresentation,
  type TextFormat,
  textFormat,
  VIEWER_LIMITS,
  type ViewerKind,
  viewerKind,
} from "@localdot/protocol";
import {
  lazy,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileName } from "../../agent/ResultFiles.tsx";
import { bytes } from "../../copy/format.ts";
import type { ApiClient } from "../../lib/api.ts";
import { Button } from "../../ui/Button.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { matches, REDUCED_MOTION } from "../../ui/media.ts";
import { Sheet } from "../../ui/Sheet.tsx";
import {
  type FileRef,
  keptPreviewBase,
  loadComputerFile,
  onComputer,
  previewBase,
  previewUrl,
} from "../api.ts";
import { openHere } from "../open-here.ts";
import { useVersions } from "../useVersions.ts";
import { comparePair, findVersion } from "../versions.ts";
import { type Changes, ChangesView } from "./ChangesView.tsx";
import { MediaView } from "./MediaView.tsx";
import { PageView } from "./PageView.tsx";
import { PictureView } from "./PictureView.tsx";
import {
  type AnyEntry,
  anyEntryKey,
  isComputerEntry,
  type ShownVersion,
  type ViewerDownloads,
} from "./scope.tsx";
import { ViewerBar, ViewerLoading, ViewerMessage, ViewSwitch } from "./states.tsx";
import { TableView } from "./TableView.tsx";
import { TextView } from "./TextView.tsx";
import { viewerHears } from "./viewer-keys.ts";
import { useViewChoice, type ViewChoice, viewBucket, viewItems } from "./views.ts";
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
  entry: AnyEntry;
  name: string;
  file: FileRef;
  // Unknown for a file on the computer until the computer says.
  bytes: number | null;
  label?: number;
  // The file's own version, so a download needs no other.
  own: boolean;
}
function itemOf(entry: AnyEntry, shown?: ShownVersion & { key: string }): Item {
  const key = anyEntryKey(entry);
  if (isComputerEntry(entry)) {
    const name = computerFileName(entry.path);
    return {
      key,
      entry,
      name,
      file: { sessionId: entry.sessionId, name, path: entry.path },
      bytes: null,
      own: true,
    };
  }
  const pick = shown?.key === key ? shown : undefined;
  const own = entry.file.version ?? null;
  return {
    key,
    entry,
    name: entry.file.name,
    file: {
      sessionId: pick?.sessionId ?? entry.sessionId,
      name: entry.file.name,
      version: pick ? pick.version : own,
    },
    bytes: pick?.bytes ?? entry.file.bytes,
    label: pick?.label,
    own: !pick || (pick.sessionId === entry.sessionId && pick.version === own),
  };
}
type About = ComputerFileReply | "failed";
const UNREACHABLE: Partial<Record<string, string>> = {
  computer_off: "Turn on your computer to get this file.",
  busy: "Your computer is busy. Try again in a moment.",
  missing: "This file is no longer on the computer.",
};
// What the computer says of a file on it: its size now, or why it can't be read.
function useAbout(api: ApiClient, file: FileRef, attempt: number): About | null {
  const [about, setAbout] = useState<{ key: string; about: About } | null>(null);
  const key = onComputer(file) ? `${file.sessionId}/${file.path}/${attempt}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the file and the attempt.
  useEffect(() => {
    if (!onComputer(file)) return;
    const controller = new AbortController();
    loadComputerFile(api, file, controller.signal).then(
      (reply) => !controller.signal.aborted && setAbout({ key, about: reply }),
      () => !controller.signal.aborted && setAbout({ key, about: "failed" }),
    );
    return () => controller.abort();
  }, [api, key]);
  return about?.key === key ? about.about : null;
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

export interface FileViewerProps<E extends AnyEntry> {
  api: ApiClient;
  entries: readonly E[];
  index: number;
  shown?: ShownVersion & { key: string };
  open: boolean;
  downloads: ViewerDownloads<E>;
  onMac: boolean;
  previewWidth?: number;
  displayName?: string;
  returnFocus?: RefObject<HTMLElement | null>;
  // The view the file opens on, such as Changes from a change's own preview.
  view?: string;
  onIndex(next: number): void;
  onClose(): void;
}

// The full preview: the file large in a wide sheet (a full-height sheet on a phone), with the arrow
// keys, a swipe or the buttons moving between the files beside it, and Download and Open on Mac
// always in reach.
export function FileViewer<E extends AnyEntry>({
  api,
  entries,
  index,
  shown,
  open,
  downloads,
  onMac,
  previewWidth,
  displayName,
  returnFocus,
  view,
  onIndex,
  onClose,
}: FileViewerProps<E>) {
  const entry = entries[index] as E;
  const item = itemOf(entry, shown);
  const total = entries.length;
  const root = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState<{ key: string; from: -1 | 1 } | null>(null);
  const go = (step: -1 | 1) => {
    const next = index + step;
    if (next < 0 || next >= total) return;
    const key = entries[next] && anyEntryKey(entries[next]);
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
      if (!host || !viewerHears(host, event)) return;
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

  const [attempt, setAttempt] = useState(0);
  const about = useAbout(api, item.file, attempt);
  const size =
    item.bytes ?? (about && about !== "failed" && about.kind === "file" ? about.bytes : null);
  const state = downloads.state(entry);
  const kind = viewerKind(item.name);
  // The arrows turn a document's own pages.
  const paged = kind === "pdf" || kind === "page";
  const meta = [
    kindLabel(item.name),
    size === null ? null : bytes(size),
    item.label ? `v${item.label}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const download = (
    <Button
      size="md"
      icon={state === "done" ? "check" : "download"}
      busy={state === "busy"}
      disabledReason={
        downloads.blocked(entry) ??
        (about && about !== "failed" && about.kind === "none"
          ? UNREACHABLE[about.reason]
          : undefined)
      }
      onClick={() =>
        downloads.request(
          entry,
          item.own || onComputer(item.file)
            ? undefined
            : { sessionId: item.file.sessionId, version: item.file.version },
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
        {onMac && !onComputer(item.file) && canOpenOnMac(item.name) && (
          <Button
            size="md"
            variant="secondary"
            onClick={() =>
              !onComputer(item.file) &&
              void openHere(api, item.file.sessionId, item.name, item.file.version)
            }
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
      returnFocus={returnFocus}
      onClose={onClose}
      title={
        <>
          <span className="ui-visually-hidden">{displayName ?? item.name}</span>
          <span aria-hidden="true">
            <FileName name={displayName ?? item.name} />
          </span>
        </>
      }
      description={meta}
      className={previewWidth ? "file-viewer step-preview-sheet" : "file-viewer"}
      style={previewWidth ? { left: 8, right: "auto", width: previewWidth } : undefined}
      size="wide"
      modal={!previewWidth}
      closeOutside
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
          key={`${item.key}/${JSON.stringify(item.file)}`}
          className="viewer-pane"
          data-kind={kind}
          data-from={enteredFrom === 1 ? "right" : enteredFrom === -1 ? "left" : undefined}
        >
          <ViewBody
            api={api}
            item={item}
            kind={kind}
            size={size}
            about={about}
            view={view}
            download={download}
            retry={() => setAttempt((n) => n + 1)}
          />
        </div>
      </div>
    </Sheet>
  );
}

// A kept link shows the file at once; the daemon's answer replaces it if the daemon has restarted.
function usePreviewUrl(api: ApiClient, file: FileRef, wanted: boolean): string | null | "failed" {
  const [url, setUrl] = useState<{ key: string; url: string | "failed" } | null>(null);
  const key = JSON.stringify(file);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the file.
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    const show = (next: string) =>
      setUrl((was) => (was?.key === key && was.url === next ? was : { key, url: next }));
    const kept = keptPreviewBase(api, file.sessionId);
    if (kept) show(previewUrl(api, kept, file));
    previewBase(api, file.sessionId, controller.signal).then(
      (base) => !controller.signal.aborted && show(previewUrl(api, base, file)),
      () => !controller.signal.aborted && !kept && show("failed"),
    );
    return () => controller.abort();
  }, [api, key, wanted]);
  return url?.key === key ? url.url : null;
}

// What changed in the file: the task's own edits of a file on the computer, or, for a text version
// dot handed over, what changed from the version before it.
function useChanges(api: ApiClient, item: Item): Changes | null {
  const { entry, file, name } = item;
  const kind = fileKind(name);
  const versions = useVersions(
    api,
    file.sessionId,
    name,
    0,
    !onComputer(file) && (kind === "text" || kind === "table"),
  );
  return useMemo(() => {
    if (isComputerEntry(entry))
      return entry.changes?.some((change) => change.patch)
        ? { kind: "patches", patches: entry.changes }
        : null;
    if (onComputer(file) || !versions) return null;
    const pair = comparePair(name, versions, findVersion(versions, file));
    return pair
      ? {
          kind: "versions",
          file: { sessionId: entry.sessionId, name, version: file.version },
          from: pair[0],
          to: pair[1],
        }
      : null;
  }, [entry, file, name, versions]);
}

const ABOUT_TITLES: Record<string, string> = {
  computer_off: "Turn on your computer to see this file",
  busy: "Your computer is busy",
  missing: "This file is no longer on the computer",
  too_large: "Too large to preview",
};

function ViewBody({
  api,
  item,
  kind,
  size,
  about,
  view,
  download,
  retry,
}: {
  api: ApiClient;
  item: Item;
  kind: ViewerKind;
  size: number | null;
  about: About | null;
  view?: string;
  download: ReactNode;
  retry(): void;
}) {
  const { name, file } = item;
  const computer = onComputer(file);
  const changes = useChanges(api, item);
  const bucket = viewBucket(kind, name);
  const items = useMemo(
    () => viewItems(bucket, { pages: kind === "sheet" && !computer, changes: !!changes }),
    [bucket, kind, computer, changes],
  );
  const choice = useViewChoice(bucket, items, view);
  const cap = CAPS[kind];
  const tooLarge = cap !== undefined && size !== null && size > cap;
  const reachable = !computer || (about !== null && about !== "failed" && about.kind === "file");
  const drawn = ["picture", "svg", "pdf", "html", "audio", "video"].includes(kind);
  const url = usePreviewUrl(api, file, drawn && reachable && !tooLarge);
  if (changes && choice.value === "changes")
    return <ChangesView api={api} name={name} changes={changes} choice={choice} />;
  if (!reachable)
    return (
      <Unreachable name={name} about={about} choice={choice} download={download} retry={retry} />
    );
  const lead = <ViewSwitch choice={choice} />;
  if (tooLarge)
    return (
      <>
        {items.length > 1 && <ViewerBar>{lead}</ViewerBar>}
        <ViewerMessage name={name} title="Too large to preview" action={download}>
          {bytes(size)} is more than this preview opens.
        </ViewerMessage>
      </>
    );
  if (url === "failed") return <ViewerMessage name={name} title="Couldn't load the preview" />;
  const source = choice.value === "source";
  if (kind === "text" || kind === "details" || (source && (kind === "table" || kind === "svg")))
    return <TextView api={api} file={file} download={download} choice={choice} />;
  if (kind === "table") return <TableView api={api} file={file} lead={lead} />;
  if (kind === "sheet")
    return onComputer(file) || choice.value !== "pages" ? (
      <TableView api={api} file={file} lead={lead} />
    ) : (
      <Suspense fallback={<ViewerLoading label="Loading the pages" />}>
        <OfficePages api={api} file={file} lead={lead} />
      </Suspense>
    );
  if (kind === "page")
    return onComputer(file) ? (
      <ViewerMessage name={name} title="No preview for this kind of file" action={download}>
        Download it to open it in another app.
      </ViewerMessage>
    ) : (
      <Suspense fallback={<ViewerLoading label="Loading the pages" />}>
        <OfficePages api={api} file={file} />
      </Suspense>
    );
  if (kind === "html") return <PageView api={api} url={url} file={file} choice={choice} />;
  if (url === null) return <ViewerLoading label="Loading the preview" />;
  if (kind === "pdf")
    return (
      <Suspense fallback={<ViewerLoading label="Loading the PDF" />}>
        <PdfFile key={url} api={api} url={url} name={name} />
      </Suspense>
    );
  if (kind === "audio" || kind === "video")
    return <MediaView key={url} url={url} kind={kind} name={name} />;
  return <PictureView key={url} src={url} name={name} lead={lead} />;
}

// A file on the computer the viewer can't read now, and why.
function Unreachable({
  name,
  about,
  choice,
  download,
  retry,
}: {
  name: string;
  about: About | null;
  choice: ViewChoice;
  download: ReactNode;
  retry(): void;
}) {
  const reason = about && about !== "failed" && about.kind === "none" ? about.reason : null;
  const again = (
    <Button size="md" variant="secondary" onClick={retry}>
      Try again
    </Button>
  );
  return (
    <>
      {choice.items.length > 1 && (
        <ViewerBar>
          <ViewSwitch choice={choice} />
        </ViewerBar>
      )}
      {about === null ? (
        <ViewerLoading label="Reading the file on your computer" />
      ) : (
        <ViewerMessage
          name={name}
          title={(reason && ABOUT_TITLES[reason]) || "Couldn't read this file"}
          action={reason === "too_large" ? download : reason === "missing" ? undefined : again}
        >
          {reason === "missing"
            ? "It was moved or deleted after the task listed it."
            : reason === "computer_off"
              ? "The file stays on your computer while it is off."
              : undefined}
        </ViewerMessage>
      )}
    </>
  );
}
