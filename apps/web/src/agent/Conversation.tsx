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
import { Glyph } from "../dot/Glyph.tsx";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
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
// The dock stays in view while the thread scrolls under it, unless it would take more than this
// share of the view; then it scrolls away with the thread, so history is never read through a slot.
const DOCK_SHARE = 0.45;
const itemKey = (item: ThreadItem) => item.key;

interface ThreadContext {
  announce(text: string): void;
  downloads: ResultDownloads;
  live: LiveWork | null;
  ended?: "done" | "stopped" | "error";
  pendingAsk: string | null;
  latestWork: string | undefined;
  onReplay?: () => void;
}
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
      live={item.key === thread.latestWork ? thread.live : null}
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
  // The composer, or the answer panel while dot waits for one. It stays at the foot of the thread.
  dock?: ReactNode;
  onReplay?: () => void;
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
}: ConversationProps) {
  const page = usePagedRows(items, itemKey, ownerKey, { size: WINDOW, step: WINDOW / 2 });
  const follow = useFollowScroll(ownerKey, true);
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
  const latestWork = items.findLast((item) => item.kind === "work")?.key;

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

  const paging = useRef({ page, pinned: follow.pinned });
  paging.current = { page, pinned: follow.pinned };
  const observer = useRef<IntersectionObserver | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  // Reaching either end of the mounted window moves it; the rows in view stay mounted and in place.
  const edges = useMemo(() => {
    const watch = (edge: "older" | "newer") => (element: HTMLElement | null) => {
      if (!element) return;
      if (!observer.current && typeof IntersectionObserver !== "undefined" && scroller.current)
        observer.current = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const { page: now, pinned } = paging.current;
              const end = (entry.target as HTMLElement).dataset.edge;
              if (end === "older" && !pinned && now.hasOlder) now.older();
              else if (end === "newer" && now.hasNewer) now.newer();
            }
          },
          { root: scroller.current, rootMargin: "240px 0px" },
        );
      element.dataset.edge = edge;
      observer.current?.observe(element);
      return () => observer.current?.unobserve(element);
    };
    return { older: watch("older"), newer: watch("newer") };
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      scroller.current = element;
      follow.ref(element);
    },
    [follow.ref],
  );

  // Written straight onto the elements, so scrolling never re-renders the thread. The jump button
  // and scrolled-to rows keep clear of the part of the dock in view.
  const body = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const placeDock = useCallback(() => {
    const view = scroller.current?.getBoundingClientRect();
    const foot = footer.current;
    if (!view || !foot || !body.current) return;
    foot.toggleAttribute("data-docked", foot.offsetHeight <= view.height * DOCK_SHARE);
    const top = foot.getBoundingClientRect().top;
    const shown = Math.max(0, Math.min(foot.offsetHeight, view.bottom - top));
    body.current.style.setProperty("--thread-dock-shown", `${Math.round(shown)}px`);
  }, []);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(placeDock);
    if (scroller.current) observer.observe(scroller.current);
    if (footer.current) observer.observe(footer.current);
    return () => observer.disconnect();
  }, [placeDock]);

  const thread: ThreadContext = {
    announce,
    downloads,
    live,
    ended,
    pendingAsk,
    latestWork,
    onReplay,
  };
  const empty = !items.length;
  return (
    <div className="thread-body" ref={body}>
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {visible && announcement.owner === ownerKey ? announcement.text : ""}
      </VisuallyHidden>
      <ScrollArea
        ref={attach}
        className="thread-scroll"
        fade="top"
        onScroll={() => {
          placeDock();
          if (!visible) return;
          if (!follow.onScroll()) page.freeze();
          else if (!page.following && !page.hasNewer) page.latest();
        }}
        onWheel={follow.interrupt}
        onTouchStart={follow.interrupt}
        onPointerDown={follow.interrupt}
        onKeyDown={follow.interrupt}
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
                page.older();
                if (scroller.current) scroller.current.scrollTop = 0;
              }}
              onNewer={() => {
                page.newer();
                if (scroller.current) scroller.current.scrollTop = 0;
              }}
            />
            {empty && !live ? (
              <div className="thread-empty">
                <h3>What would you like done?</h3>
                <p>Turn on your computer, then write a task below.</p>
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
          <div className="thread-dock" ref={footer}>
            {dock}
          </div>
        </div>
      </ScrollArea>
      <span className="thread-jump" data-shown={!follow.pinned || undefined} inert={follow.pinned}>
        <Button
          size="sm"
          icon="arrow-down"
          aria-label={unread ? `${unread} new messages` : "Jump to latest"}
          onClick={() => {
            page.latest();
            follow.jump();
          }}
        >
          {unread ? `${unread} new` : "Latest"}
        </Button>
      </span>
    </div>
  );
}
