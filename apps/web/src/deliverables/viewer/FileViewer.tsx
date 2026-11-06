// Configure schemas before importing them: zod must not probe Function() against the CSP.
import "@localdot/protocol/csp";
import {
  type ComputerFileReply,
  canOpenOnMac,
  computerFileName,
  fileKind,
  VIEWER_LIMITS,
  type ViewerKind,
  viewerKind,
} from "@localdot/protocol";
import {
  lazy,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileName } from "../../agent/ResultFiles.tsx";
import { bytes } from "../../copy/format.ts";
import type { ApiClient } from "../../lib/api.ts";
import { Button } from "../../ui/Button.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { REDUCED_MOTION, useMediaQuery } from "../../ui/media.ts";
import { Sheet } from "../../ui/Sheet.tsx";
import { type FileRef, loadComputerFile, onComputer } from "../api.ts";
import { kindLabel } from "../kind-label.ts";
import { openHere } from "../open-here.ts";
import { usePreviewUrl } from "../usePreviewUrl.ts";
import { useVersions } from "../useVersions.ts";
import { comparePair, findVersion } from "../versions.ts";
import { type Changes, ChangesView } from "./ChangesView.tsx";
import { FrameView } from "./FrameView.tsx";
import { MediaView } from "./MediaView.tsx";
import { PageView } from "./PageView.tsx";
import { PictureView } from "./PictureView.tsx";
import {
  type AnyEntry,
  anyEntryKey,
  isComputerEntry,
  isFrameEntry,
  type ShownVersion,
  type ViewerDownloads,
} from "./scope.tsx";
import { ViewerBar, ViewerFile, ViewerLoading, ViewerMessage, ViewSwitch } from "./states.tsx";
import { TableView } from "./TableView.tsx";
import { TextView } from "./TextView.tsx";
import { FLICK, MOMENTUM, SETTLE, useGlide } from "./useGlide.ts";
import { viewerHears } from "./viewer-keys.ts";
import { useViewChoice, type ViewChoice, viewBucket, viewItems } from "./views.ts";
import { draggedPlace, swipeTurn } from "./zoom.ts";
import "./viewer.css";

const PdfFile = lazy(() => import("./PdfView.tsx").then((module) => ({ default: module.PdfFile })));
const OfficePages = lazy(() =>
  import("./PdfView.tsx").then((module) => ({ default: module.OfficePages })),
);
const LARGE = ["large"] as const;
// Room between neighbouring files as they pass, so one picture never touches the next.
const APART = 24;
// How hard a key at the end of the list pushes against it, in files a second.
const NUDGE = 1.2;
// Past these a file shows its card; text and tables show their start instead.
const CAPS: Partial<Record<ViewerKind, number>> = {
  picture: VIEWER_LIMITS.pictureBytes,
  svg: VIEWER_LIMITS.svgBytes,
  pdf: VIEWER_LIMITS.pdfBytes,
  html: VIEWER_LIMITS.htmlBytes,
  sheet: VIEWER_LIMITS.sheetBytes,
};
interface Item {
  key: string;
  entry: AnyEntry;
  name: string;
  // What the sheet calls it.
  title: string;
  file: FileRef;
  // Unknown for a file on the computer until the computer says.
  bytes: number | null;
  label?: number;
  // The file's own version, so a download needs no other.
  own: boolean;
}
const metaOf = (item: Item, size: number | null) =>
  [
    isFrameEntry(item.entry) ? "Recorded screenshot" : kindLabel(item.name),
    size === null ? null : bytes(size),
    item.label ? `v${item.label}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
function itemOf(entry: AnyEntry, shown?: ShownVersion & { key: string }): Item {
  const key = anyEntryKey(entry);
  if (isFrameEntry(entry)) {
    const { name, sessionId } = entry;
    return {
      key,
      entry,
      name,
      title: name,
      file: { sessionId, name, version: null },
      bytes: null,
      own: true,
    };
  }
  if (isComputerEntry(entry)) {
    const name = computerFileName(entry.path);
    return {
      key,
      entry,
      name,
      title: name,
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
    title: entry.title ?? entry.file.name,
    file: {
      sessionId: pick?.sessionId ?? entry.sessionId,
      name: entry.file.name,
      version: pick ? pick.version : own,
    },
    // A step's picture isn't measured until something has fetched it.
    bytes: pick?.bytes ?? (entry.file.bytes || null),
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

// Pictures are drawn on either side of the one on show, so a swipe carries the next one in with it;
// anything else waits until it is on show. A file on the computer has to be asked after first.
const drawnAhead = (entry: AnyEntry) =>
  isFrameEntry(entry) || (!isComputerEntry(entry) && viewerKind(entry.file.name) === "picture");
const kindOf = (item: Item) => (isFrameEntry(item.entry) ? "picture" : viewerKind(item.name));

// Puts a pane where it lies in the row of files, the row being at place `at`.
function placePane(pane: HTMLElement, at: number) {
  const x = Number(pane.dataset.index) - at;
  pane.style.transform = x === 0 ? "" : `translate3d(calc(${x} * (100% + ${APART}px)), 0, 0)`;
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
  // What the list holds, for its controls.
  noun?: "file" | "picture";
  returnFocus?: RefObject<HTMLElement | null>;
  // The view the file opens on, such as Changes from a change's own preview.
  view?: string;
  onIndex(next: number): void;
  onClose(): void;
}

// The full preview: the file large in a wide sheet (a full-height sheet on a phone), with the arrow
// keys, a swipe or the buttons moving between the files beside it, and Download and Open on Mac
// always in reach. The files lie side by side, each a sheet's width from the next; a spring carries
// the row to the one on show, and a swipe moves it 1:1 and gives less and less past either end.
export function FileViewer<E extends AnyEntry>({
  api,
  entries,
  index,
  shown,
  open,
  downloads,
  onMac,
  previewWidth,
  noun = "file",
  returnFocus,
  view,
  onIndex,
  onClose,
}: FileViewerProps<E>) {
  const entry = entries[index] as E;
  const item = itemOf(entry, shown);
  const frame = isFrameEntry(entry);
  const total = entries.length;
  const root = useRef<HTMLDivElement>(null);
  const reduced = useMediaQuery(REDUCED_MOTION);
  const paint = useCallback((at: number) => {
    for (const pane of root.current?.children ?? []) placePane(pane as HTMLElement, at);
  }, []);
  const { place, speed, goal, glide, jump, halt } = useGlide(index, reduced, paint);
  useLayoutEffect(() => paint(place.current));
  // The sheet draws its content in its own time, so a pane takes its place as it arrives.
  const position = useCallback(
    (pane: HTMLDivElement | null) => {
      if (pane) placePane(pane, place.current);
    },
    [place],
  );
  // A file chosen in the open sheet is glided to; one the sheet opens on is simply there.
  const showing = useRef(false);
  useLayoutEffect(() => {
    if (index !== goal.current) {
      if (showing.current && open) glide(index, speed.current, SETTLE);
      else jump(index);
    }
    showing.current = open;
  }, [index, open, goal, speed, glide, jump]);
  const go = (step: -1 | 1) => {
    const next = index + step;
    if (next >= 0 && next < total) onIndex(next);
    else if (total > 1) glide(index, step * NUDGE, SETTLE);
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
    from: number;
    decided?: boolean;
    moves: { t: number; x: number }[];
  } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || swipe.current) {
      // A second finger is a pinch, and the picture's to act on.
      if (swipe.current?.decided) glide(index, 0, SETTLE);
      swipe.current = null;
      return;
    }
    swipe.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from: index,
      moves: [],
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    const host = root.current;
    if (!s || s.id !== event.pointerId || !host) return;
    if (!s.decided) {
      const dx = event.clientX - s.x;
      const dy = event.clientY - s.y;
      if (Math.hypot(dx, dy) < 10) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.5 || scrollsAcross(event.target, dx, host)) {
        swipe.current = null;
        return;
      }
      s.decided = true;
      // Caught from wherever a glide had it, with no jump to meet the finger.
      halt();
      s.x = event.clientX;
      s.from = place.current;
      host.setPointerCapture(event.pointerId);
    }
    s.moves = [...s.moves.slice(-5), { t: event.timeStamp, x: event.clientX }];
    const pitch = host.clientWidth + APART;
    place.current = draggedPlace(s.from - (event.clientX - s.x) / pitch, total, pitch);
    paint(place.current);
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
    const width = root.current?.clientWidth ?? 390;
    const turn =
      event.type === "pointercancel" ? 0 : swipeTurn(event.clientX - s.x, velocity, width);
    const to = Math.min(total - 1, Math.max(0, index + turn));
    glide(to, -velocity / (width + APART), Math.abs(velocity) > FLICK ? MOMENTUM : SETTLE);
    if (to !== index) onIndex(to);
  };

  const [attempt, setAttempt] = useState(0);
  const about = useAbout(api, item.file, attempt);
  const size =
    item.bytes ?? (about && about !== "failed" && about.kind === "file" ? about.bytes : null);
  const state = frame ? undefined : downloads.state(entry);
  const kind = kindOf(item);
  // The arrows turn a document's own pages.
  const paged = kind === "pdf" || kind === "page";
  const meta = metaOf(item, size);
  const download = !frame && (
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
  const openMac = onMac && !frame && !onComputer(item.file) && canOpenOnMac(item.name) && (
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
  );
  const actions = (
    <>
      {openMac}
      {download}
    </>
  );
  const footer = (
    <div className="viewer-footer">
      {total > 1 ? (
        <div className="viewer-nav">
          <IconButton
            icon="chevron-left"
            size={32}
            label={`Previous ${noun}`}
            kbd={paged ? undefined : ["←"]}
            disabledReason={index === 0 ? `This is the first ${noun}` : undefined}
            onClick={() => go(-1)}
          />
          <span className="viewer-count num">
            {index + 1} of {total}
          </span>
          <IconButton
            icon="chevron-right"
            size={32}
            label={`Next ${noun}`}
            kbd={paged ? undefined : ["→"]}
            disabledReason={index === total - 1 ? `This is the last ${noun}` : undefined}
            onClick={() => go(1)}
          />
        </div>
      ) : (
        <span />
      )}
      <div className="viewer-actions">{actions}</div>
    </div>
  );
  const panes = [index - 1, index, index + 1].flatMap((at) => {
    const near = entries[at];
    return near && (at === index || drawnAhead(near)) ? [{ at, item: itemOf(near, shown) }] : [];
  });
  return (
    <Sheet
      open={open}
      returnFocus={returnFocus}
      onClose={onClose}
      title={
        <>
          <span className="ui-visually-hidden">{item.title}</span>
          <span aria-hidden="true">
            <FileName name={item.title} />
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
      footer={total > 1 || download ? footer : undefined}
    >
      <div
        ref={root}
        className="viewer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {panes.map((pane) => {
          const onShow = pane.at === index;
          return (
            <div
              ref={position}
              key={`${pane.item.key}/${JSON.stringify(pane.item.file)}`}
              className="viewer-pane"
              data-index={pane.at}
              data-kind={kindOf(pane.item)}
              data-aside={onShow ? undefined : ""}
              inert={!onShow}
              aria-hidden={onShow ? undefined : true}
            >
              <ViewerFile.Provider
                value={{
                  meta: onShow ? meta : metaOf(pane.item, pane.item.bytes),
                  actions: onShow ? actions : undefined,
                }}
              >
                {isFrameEntry(pane.item.entry) ? (
                  <FrameView api={api} frame={pane.item.entry} />
                ) : (
                  <ViewBody
                    api={api}
                    item={pane.item}
                    kind={kindOf(pane.item)}
                    size={onShow ? size : pane.item.bytes}
                    about={onShow ? about : null}
                    view={onShow ? view : undefined}
                    attempt={attempt}
                    retry={() => setAttempt((n) => n + 1)}
                  />
                )}
              </ViewerFile.Provider>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
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
};

function ViewBody({
  api,
  item,
  kind,
  size,
  about,
  view,
  attempt,
  retry,
}: {
  api: ApiClient;
  item: Item;
  kind: ViewerKind;
  size: number | null;
  about: About | null;
  view?: string;
  attempt: number;
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
  const url = usePreviewUrl(api, file, drawn && reachable && !tooLarge, attempt);
  if (changes && choice.value === "changes")
    return <ChangesView api={api} name={name} changes={changes} choice={choice} />;
  if (!reachable) return <Unreachable name={name} about={about} choice={choice} retry={retry} />;
  const lead = <ViewSwitch choice={choice} />;
  if (tooLarge)
    return (
      <>
        {items.length > 1 && <ViewerBar>{lead}</ViewerBar>}
        <ViewerMessage name={name} />
      </>
    );
  if (url === "failed")
    return <ViewerMessage name={name} title="Couldn't load the preview" retry={retry} />;
  const source = choice.value === "source";
  if (kind === "text" || kind === "details" || (source && (kind === "table" || kind === "svg")))
    return <TextView api={api} file={file} choice={choice} />;
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
      <ViewerMessage name={name} />
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
    return <MediaView key={`${url}/${attempt}`} url={url} kind={kind} name={name} retry={retry} />;
  return <PictureView key={url} src={url} name={item.title} lead={lead} />;
}

// A file on the computer the viewer can't read now, and why.
function Unreachable({
  name,
  about,
  choice,
  retry,
}: {
  name: string;
  about: About | null;
  choice: ViewChoice;
  retry(): void;
}) {
  const reason = about && about !== "failed" && about.kind === "none" ? about.reason : null;
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
          title={
            reason === "too_large"
              ? undefined
              : (reason && ABOUT_TITLES[reason]) || "Couldn't read this file"
          }
          retry={reason === "too_large" || reason === "missing" ? undefined : retry}
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
