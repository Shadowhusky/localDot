import { keyLikePresent } from "@localdot/protocol";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { count } from "../copy/format.ts";
import { Glyph } from "../dot/Glyph.tsx";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { HistoryPages } from "./HistoryPages.tsx";
import { type LiveWork, LiveWorkLine } from "./LiveWorkLine.tsx";
import type { AgentMessage, AgentResult } from "./model.ts";
import { answerText, QuestionCard } from "./QuestionCard.tsx";
import { ResultCard, type ResultDownloads, useResultDownloads } from "./ResultFiles.tsx";
import { SafeMarkdown } from "./SafeMarkdown.tsx";
import { type ThreadItem, type ThreadKind, type ThreadRow, threadRows } from "./thread.ts";
import { useFollowScroll } from "./useFollowScroll.ts";
import { usePagedRows } from "./usePagedRows.ts";

// The thread mounts at most this many items; scrolling to either end moves it by half.
const WINDOW = 200;
// The foot (the live work line and the composer) sits under the thread and stays put while it
// scrolls, as long as the thread keeps this much room above it. A taller foot joins the end of the
// thread instead, so the column keeps one scroller; it comes back under with a little to spare.
const THREAD_ROOM = 200;
const ROOM_BACK = 224;
const itemKey = (item: ThreadItem) => item.key;

interface ThreadContext {
  announce(text: string): void;
  downloads: ResultDownloads;
  ended?: "done" | "stopped" | "error";
  pendingAsk: string | null;
  latestWork: string | undefined;
  onReplay?: () => void;
}
type WorkItem = Extract<ThreadItem, { kind: "work" }>;
type CardOf<K extends ThreadKind> = (props: {
  item: Extract<ThreadItem, { kind: K }>;
  thread: ThreadContext;
}) => ReactNode;

const MessageCard = memo(function MessageCard({
  message,
  announce,
}: {
  message: AgentMessage;
  announce(text: string): void;
}) {
  const user = message.role === "user";
  const copy = (
    <CopyButton
      className="thread-copy"
      text={message.text}
      label={user ? "Copy your message" : "Copy dot's message"}
      announce={announce}
    />
  );
  return (
    <article
      className="thread-message"
      data-role={user ? "user" : "dot"}
      data-streaming={!message.final || undefined}
      aria-label={user ? "You" : "dot"}
    >
      <span className="thread-copy-slot" inert={!message.final}>
        {copy}
      </span>
      {user ? (
        <p className="thread-bubble">{message.text}</p>
      ) : (
        <SafeMarkdown text={message.text} announce={announce} />
      )}
      {message.truncated && <p className="thread-note">Message preview shortened.</p>}
    </article>
  );
});

const CARDS: { [K in ThreadKind]: CardOf<K> } = {
  message: ({ item, thread }) => <MessageCard message={item.message} announce={thread.announce} />,
  question: ({ item, thread }) => (
    <QuestionCard question={item.question} pending={thread.pendingAsk === item.question.askId} />
  ),
  answer: ({ item }) => (
    <article className="thread-message" data-role="user" aria-label="Your answer">
      <p className="thread-bubble">{answerText(item.question)}</p>
    </article>
  ),
  result: ({ item, thread }) => (
    <ResultCard result={item.result} downloads={thread.downloads} onReplay={thread.onReplay} />
  ),
  work: ({ item, thread }) => (
    <LiveWorkLine
      steps={item.steps}
      startMs={item.startMs}
      live={null}
      ended={item.key === thread.latestWork ? thread.ended : undefined}
    />
  ),
};

function Card({ item, thread }: { item: ThreadItem; thread: ThreadContext }) {
  const Render = CARDS[item.kind] as CardOf<ThreadKind>;
  return <Render item={item as never} thread={thread} />;
}

function Row({ row, fresh, thread }: { row: ThreadRow; fresh: boolean; thread: ThreadContext }) {
  const { item } = row;
  return (
    <div
      className="thread-row"
      data-anchor=""
      data-kind={item.kind}
      data-speaker={item.speaker}
      data-group-start={row.groupStart || undefined}
      data-new={fresh || undefined}
    >
      {row.separator && (
        <p className="thread-time">
          <time>{row.separator}</time>
        </p>
      )}
      {row.groupStart && item.speaker === "dot" && (
        <p className="thread-who" aria-hidden="true">
          <Glyph size={14} />
          dot
        </p>
      )}
      <Card item={item} thread={thread} />
    </div>
  );
}

export interface ConversationProps {
  items: readonly ThreadItem[];
  truncated: boolean;
  visible?: boolean;
  ownerKey?: string;
  // The latest turn's work while its task has not ended.
  live?: LiveWork | null;
  ended?: "done" | "stopped" | "error";
  pendingAsk?: string | null;
  api?: ApiClient | null;
  sessionId?: string | null;
  recovery?: ReactNode;
  error?: string | null;
  // The composer, or the answer panel while dot waits for one, under the thread.
  dock?: ReactNode;
  onReplay?: () => void;
  computerReady?: boolean;
}

export function Conversation({
  items,
  truncated,
  visible = true,
  ownerKey = "",
  live = null,
  ended,
  pendingAsk = null,
  api = null,
  sessionId = null,
  recovery,
  error,
  dock,
  onReplay,
  computerReady = false,
}: ConversationProps) {
  // While its task is live, the latest turn's work line sits in the foot, always in view; once the
  // turn is over it joins the thread as that turn's last row.
  const latestWork = items.findLast((item) => item.kind === "work") as WorkItem | undefined;
  const liveWork = live ? latestWork : undefined;
  const shown = useMemo(
    () => (liveWork ? items.filter((item) => item !== liveWork) : items),
    [items, liveWork],
  );
  const lastLive = useRef<WorkItem | undefined>(undefined);
  if (liveWork) lastLive.current = liveWork;
  const footWork = liveWork ?? lastLive.current;
  const page = usePagedRows(shown, itemKey, ownerKey, { size: WINDOW, step: WINDOW / 2 });
  // Following the end, the end is held in the same frame as anything arrives, so nothing at the
  // end moves; a new row eases in where it lands instead.
  const follow = useFollowScroll(ownerKey, true, { glide: false });
  const [announcement, setAnnouncement] = useState({ owner: ownerKey, text: "" });
  const announce = useCallback(
    (text: string) =>
      setAnnouncement((old) => ({
        owner: ownerKey,
        // The same words twice still count as news.
        text: old.text === text ? `${text} ` : text,
      })),
    [ownerKey],
  );
  const results = useMemo(
    () => items.flatMap((item) => (item.kind === "result" ? [item.result] : [])) as AgentResult[],
    [items],
  );
  const downloads = useResultDownloads(api, sessionId, results, announce);
  const rows = useMemo(() => threadRows(page.rows), [page.rows]);

  const announced = useRef({ owner: ownerKey, id: "" });
  const completed = items.findLast(
    (item) => item.kind === "message" && item.message.role === "assistant" && item.message.final,
  );
  useEffect(() => {
    if (!visible || completed?.kind !== "message") return;
    const message = completed.message;
    if (announced.current.owner === ownerKey && announced.current.id === message.id) return;
    announced.current = { owner: ownerKey, id: message.id };
    setAnnouncement({
      owner: ownerKey,
      text: keyLikePresent(message.text)
        ? "dot replied."
        : `dot replied: ${message.text.slice(0, 200)}`,
    });
  }, [completed, ownerKey, visible]);

  // Items that arrive at the end after the thread first drew ease in; history appears as it is.
  const known = useRef<{ owner: string; keys: Set<string> }>({ owner: ownerKey, keys: new Set() });
  if (known.current.owner !== ownerKey) known.current = { owner: ownerKey, keys: new Set() };
  const settled = known.current.keys.size > 0;
  const lastKnown = rows.findLastIndex((row) => known.current.keys.has(row.item.key));
  useLayoutEffect(() => {
    for (const row of rows) known.current.keys.add(row.item.key);
  }, [rows]);

  // What arrived since the reader left the end.
  const [left, setLeft] = useState<{ owner: string; keys: Set<string> } | null>(null);
  if (follow.pinned && left) setLeft(null);
  else if (!follow.pinned && left?.owner !== ownerKey)
    setLeft({ owner: ownerKey, keys: new Set(items.map(itemKey)) });
  const unread = left
    ? items.filter((item) => item.kind !== "work" && !left.keys.has(item.key)).length
    : 0;

  const paging = useRef({ page, following: follow.following });
  paging.current = { page, following: follow.following };
  const observer = useRef<IntersectionObserver | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  // Reaching either end of the mounted window moves it; the rows in view stay mounted and in place.
  // A page moved by its buttons waits for the reader's own scrolling before the edges move it again.
  const held = useRef(false);
  const reached = useRef({ older: false, newer: false });
  const moveAt = useCallback((edge: "older" | "newer") => {
    const { page: now, following } = paging.current;
    if (held.current) return;
    if (edge === "older" && !following() && now.hasOlder) now.older();
    else if (edge === "newer" && now.hasNewer) now.newer();
  }, []);
  const edges = useMemo(() => {
    const watch = (edge: "older" | "newer") => (element: HTMLElement | null) => {
      if (!element) return;
      if (!observer.current && typeof IntersectionObserver !== "undefined" && scroller.current)
        observer.current = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const end = (entry.target as HTMLElement).dataset.edge as "older" | "newer";
              reached.current[end] = entry.isIntersecting;
              if (entry.isIntersecting) moveAt(end);
            }
          },
          { root: scroller.current, rootMargin: "240px 0px" },
        );
      element.dataset.edge = edge;
      observer.current?.observe(element);
      return () => {
        reached.current[edge] = false;
        observer.current?.unobserve(element);
      };
    };
    return { older: watch("older"), newer: watch("newer") };
  }, [moveAt]);
  const reading = () => {
    follow.interrupt();
    if (!held.current) return;
    held.current = false;
    if (reached.current.older) moveAt("older");
    else if (reached.current.newer) moveAt("newer");
  };
  useEffect(() => () => observer.current?.disconnect(), []);
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      scroller.current = element;
      follow.ref(element);
    },
    [follow.ref],
  );

  // The foot's content is rendered once into its own element, which moves between the column and
  // the end of the thread without remounting, so a draft in the composer is never lost. Where it
  // is, and how much of it is in view, is written straight onto the elements, so scrolling never
  // re-renders the thread; the jump button keeps clear of it.
  const body = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [dockHost] = useState(() => {
    const host = document.createElement("div");
    host.className = "thread-dock";
    return host;
  });
  const placeDock = useCallback(() => {
    const column = body.current;
    const view = scroller.current?.getBoundingClientRect();
    if (!column || !view || !foot.current || !end.current) return;
    const inThread = dockHost.parentElement === end.current;
    const room = column.clientHeight - dockHost.offsetHeight;
    const target = room < (inThread ? ROOM_BACK : THREAD_ROOM) ? end.current : foot.current;
    if (dockHost.parentElement !== target) target.append(dockHost);
    const top = dockHost.getBoundingClientRect().top;
    const bottom = column.getBoundingClientRect().bottom;
    const inView = Math.max(0, Math.min(dockHost.offsetHeight, bottom - top));
    column.style.setProperty("--thread-foot-shown", `${Math.round(inView)}px`);
    const gutter = scroller.current
      ? scroller.current.offsetWidth - scroller.current.clientWidth
      : 0;
    column.style.setProperty("--thread-gutter", `${gutter}px`);
  }, [dockHost]);
  useLayoutEffect(() => {
    placeDock();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(placeDock);
    if (body.current) observer.observe(body.current);
    observer.observe(dockHost);
    return () => observer.disconnect();
  }, [placeDock, dockHost]);

  const thread: ThreadContext = {
    announce,
    downloads,
    ended,
    pendingAsk,
    latestWork: latestWork?.key,
    onReplay,
  };
  const empty = !shown.length && !liveWork;
  return (
    <div className="thread-body" ref={body}>
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {visible && announcement.owner === ownerKey ? announcement.text : ""}
      </VisuallyHidden>
      <ScrollArea
        ref={attach}
        className="thread-scroll"
        fade="both"
        onScroll={() => {
          placeDock();
          if (!visible) return;
          if (!follow.onScroll()) page.freeze();
          else if (!page.following && !page.hasNewer) page.latest();
        }}
        onWheel={reading}
        onTouchStart={reading}
        onPointerDown={reading}
        onKeyDown={reading}
      >
        <div className="thread-content">
          <section
            className="thread"
            aria-label="Conversation history"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users focus the history to scroll it.
            tabIndex={0}
          >
            {truncated && !page.hasOlder && (
              <p className="thread-note thread-start">Earlier messages are kept in the task log.</p>
            )}
            {page.hasOlder && (
              <p className="thread-note thread-older" ref={edges.older}>
                Loading earlier…
              </p>
            )}
            <HistoryPages
              older={page.hasOlder}
              newer={page.hasNewer}
              onOlder={() => {
                held.current = true;
                follow.release();
                page.older();
                if (scroller.current) scroller.current.scrollTop = 0;
              }}
              onNewer={() => {
                held.current = true;
                follow.release();
                page.newer();
                if (scroller.current) scroller.current.scrollTop = 0;
              }}
            />
            {empty ? (
              <div className="thread-empty">
                <h3>What would you like done?</h3>
                <p>
                  {computerReady
                    ? "Write a task below and dot does it on your computer."
                    : "Turn on your computer, then write a task below."}
                </p>
              </div>
            ) : (
              rows.map((row, index) => (
                <Row
                  key={row.item.key}
                  row={row}
                  fresh={settled && index > lastKnown && !known.current.keys.has(row.item.key)}
                  thread={thread}
                />
              ))
            )}
            {page.hasNewer && (
              <p className="thread-note thread-newer" ref={edges.newer}>
                Loading later…
              </p>
            )}
            {recovery}
            {error && (
              <p className="thread-note thread-error" role="status">
                {error}
              </p>
            )}
          </section>
          <div className="thread-end" ref={end} />
        </div>
      </ScrollArea>
      <span className="thread-jump" data-shown={!follow.pinned || undefined} inert={follow.pinned}>
        <Button
          size="sm"
          icon="arrow-down"
          aria-label={unread ? count(unread, "new message", "new messages") : "Jump to latest"}
          onClick={() => {
            page.latest();
            follow.jump();
          }}
        >
          {unread ? `${unread} new` : "Latest"}
        </Button>
      </span>
      <div className="thread-foot" ref={foot} />
      {createPortal(
        <>
          <Collapse open={!!liveWork} className="thread-live">
            {footWork && (
              <LiveWorkLine
                steps={footWork.steps}
                startMs={footWork.startMs}
                live={liveWork ? live : null}
                ended={ended}
              />
            )}
          </Collapse>
          {dock}
        </>,
        dockHost,
      )}
    </div>
  );
}
