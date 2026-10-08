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
import {
  type ThreadItem,
  type ThreadKind,
  type ThreadRow,
  threadRows,
  type WorkStep,
} from "./thread.ts";
import { reducedMotion, useFollowScroll } from "./useFollowScroll.ts";
import { usePagedRows } from "./usePagedRows.ts";

// The thread mounts at most this many items; scrolling to either end moves it by half.
const WINDOW = 200;
// The foot (the live work line and the composer) sits under the thread and stays put while it
// scrolls. Today's composer is tall, so on a shorter column the foot joins the end of the thread
// instead, which keeps one scroller and room to read. Only the column's height decides, so typing, a
// question or a field unfolding never moves the foot; the gap between the two heights covers the
// task bar coming and going.
const FOOT_FROM = 800;
const END_BELOW = 720;
// A recovery card brought into view sits this far under the scroller's faded top edge.
const REVEAL_MARGIN = 16;
const itemKey = (item: ThreadItem) => item.key;
// How long a newly shown task's history may take to arrive.
const LOADING_MS = 600;

// What the jump button says has arrived: one kind by its name, a mix as updates. Your answers are
// messages too.
const MESSAGES: [string, string] = ["new message", "new messages"];
const NEW: Partial<Record<ThreadKind, [string, string]>> = {
  message: MESSAGES,
  answer: MESSAGES,
  question: ["new question", "new questions"],
  result: ["new result", "new results"],
};
function unreadLabel(kinds: readonly ThreadKind[]): string {
  const nouns = new Set(kinds.map((kind) => NEW[kind]));
  const [one, many] = (nouns.size === 1 && [...nouns][0]) || ["new update", "new updates"];
  return count(kinds.length, one, many);
}

// Rows that would drop start where they were drawn, this far above, and ease down to where they sit.
function easeDown(element: HTMLElement, from: number) {
  const style = getComputedStyle(element);
  const frames = [{ transform: `translateY(${from}px)` }, { transform: "none" }];
  const spring = style.getPropertyValue("--dur-spring").trim();
  const duration = Number.parseFloat(spring) * (spring.endsWith("ms") ? 1 : 1000) || 360;
  try {
    element.animate(frames, { duration, easing: style.getPropertyValue("--ease-spring").trim() });
  } catch {
    element.animate(frames, { duration, easing: "ease-out" });
  }
}

interface ThreadContext {
  announce(text: string): void;
  downloads: ResultDownloads;
  ended?: "done" | "stopped" | "error";
  pendingAsk: string | null;
  latestWork: string | undefined;
  onReplay?: () => void;
}
type ItemOf<K extends ThreadKind> = Extract<ThreadItem, { kind: K }>;
type WorkItem = ItemOf<"work">;
// One kind of row in the thread: how it draws, and whether an item rebuilt by a later event still
// draws as it did, so the row need not redraw.
interface CardKind<K extends ThreadKind> {
  draw(props: { item: ItemOf<K>; thread: ThreadContext }): ReactNode;
  same(was: ItemOf<K>, now: ItemOf<K>, then: ThreadContext, thread: ThreadContext): boolean;
}

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

const endedOf = (item: WorkItem, thread: ThreadContext) =>
  item.key === thread.latestWork ? thread.ended : undefined;

// A turn's steps are rebuilt with every event; they draw the same while what the line shows of
// them is the same.
function sameSteps(was: readonly WorkStep[], now: readonly WorkStep[]): boolean {
  return (
    was === now ||
    (was.length === now.length &&
      was.every((step, index) => {
        const other = now[index];
        return (
          !!other &&
          step.key === other.key &&
          step.state === other.state &&
          step.title === other.title &&
          step.metric === other.metric &&
          step.startT === other.startT &&
          step.endT === other.endT
        );
      }))
  );
}

const CARDS: { [K in ThreadKind]: CardKind<K> } = {
  message: {
    draw: ({ item, thread }) => <MessageCard message={item.message} announce={thread.announce} />,
    same: (was, now, then, thread) =>
      was.message === now.message && then.announce === thread.announce,
  },
  question: {
    draw: ({ item, thread }) => (
      <QuestionCard question={item.question} pending={thread.pendingAsk === item.question.askId} />
    ),
    same: (was, now, then, thread) =>
      was.question === now.question &&
      (then.pendingAsk === was.question.askId) === (thread.pendingAsk === now.question.askId),
  },
  answer: {
    draw: ({ item }) => (
      <article className="thread-message" data-role="user" aria-label="Your answer">
        <p className="thread-bubble">{answerText(item.question)}</p>
      </article>
    ),
    same: (was, now) => was.question === now.question,
  },
  result: {
    draw: ({ item, thread }) => (
      <ResultCard result={item.result} downloads={thread.downloads} onReplay={thread.onReplay} />
    ),
    same: (was, now, then, thread) =>
      was.result === now.result &&
      then.downloads === thread.downloads &&
      then.onReplay === thread.onReplay,
  },
  work: {
    draw: ({ item, thread }) => (
      <LiveWorkLine
        steps={item.steps}
        startMs={item.startMs}
        live={null}
        ended={endedOf(item, thread)}
      />
    ),
    same: (was, now, then, thread) =>
      was.startMs === now.startMs &&
      endedOf(was, then) === endedOf(now, thread) &&
      sameSteps(was.steps, now.steps),
  },
};

function Card({ item, thread }: { item: ThreadItem; thread: ThreadContext }) {
  const { draw: Draw } = CARDS[item.kind] as CardKind<ThreadKind>;
  return <Draw item={item} thread={thread} />;
}

interface RowProps {
  row: ThreadRow;
  fresh: boolean;
  thread: ThreadContext;
}

// Items are rebuilt on every event and the thread redraws each second while a task runs, so a row
// redraws only when its card says it draws differently.
function sameRow(a: RowProps, b: RowProps): boolean {
  const x = a.row.item,
    y = b.row.item;
  return (
    x.kind === y.kind &&
    (CARDS[x.kind] as CardKind<ThreadKind>).same(x, y, a.thread, b.thread) &&
    a.row.groupStart === b.row.groupStart &&
    a.row.separator === b.row.separator &&
    a.fresh === b.fresh
  );
}

const Row = memo(function Row({ row, fresh, thread }: RowProps) {
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
}, sameRow);

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
  // Under the thread: the composer, and the answer panel, which takes its place while dot waits for
  // one. The composer stays mounted, so a draft survives.
  composer?: ReactNode;
  answer?: ReactNode;
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
  composer,
  answer,
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
  const replayNow = useRef(onReplay);
  replayNow.current = onReplay;
  const replay = useCallback(() => replayNow.current?.(), []);
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

  // Items that arrive at the end once the thread has drawn its history ease in; history, which may
  // come in a few batches as the task loads, appears as it is.
  const known = useRef({ owner: ownerKey, keys: new Set<string>(), since: performance.now() });
  if (known.current.owner !== ownerKey)
    known.current = { owner: ownerKey, keys: new Set(), since: performance.now() };
  const settled =
    known.current.keys.size > 0 && performance.now() - known.current.since > LOADING_MS;
  const lastKnown = rows.findLastIndex((row) => known.current.keys.has(row.item.key));
  useLayoutEffect(() => {
    for (const row of rows) known.current.keys.add(row.item.key);
  }, [rows]);

  // A card brought into view holds the reader there; until they move on their own, what still
  // arrives (history loading in batches) counts as read.
  const [holding, setHolding] = useState<string | null>(null);
  const holdsCard = holding === ownerKey;
  // What arrived since the reader left the end.
  const [left, setLeft] = useState<{ owner: string; keys: Set<string> } | null>(null);
  if (follow.pinned && left) setLeft(null);
  else if (
    !follow.pinned &&
    (left?.owner !== ownerKey || (holdsCard && left.keys.size !== items.length))
  )
    setLeft({ owner: ownerKey, keys: new Set(items.map(itemKey)) });
  const unread = left
    ? items
        .filter((item) => item.kind !== "work" && !left.keys.has(item.key))
        .map((item) => item.kind)
    : [];

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
    setHolding(null);
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
  const jump = useRef<HTMLSpanElement>(null);
  const [dockHost] = useState(() => {
    const host = document.createElement("div");
    host.className = "thread-dock";
    return host;
  });
  const footShown = useCallback(() => {
    const column = body.current;
    if (!column || !jump.current) return;
    const top = dockHost.getBoundingClientRect().top;
    const bottom = column.getBoundingClientRect().bottom;
    const inView = Math.max(0, Math.min(dockHost.offsetHeight, bottom - top));
    jump.current.style.setProperty("--thread-foot-shown", `${Math.round(inView)}px`);
  }, [dockHost]);
  const placeDock = useCallback(() => {
    const column = body.current;
    if (!column || !foot.current || !end.current) return;
    const height = column.clientHeight;
    const under = dockHost.parentElement === foot.current;
    const target =
      height >= FOOT_FROM || (under && height >= END_BELOW) ? foot.current : end.current;
    // Moving an element takes the focus out of it, so the foot moves once the focus has left it.
    if (dockHost.parentElement !== target && !dockHost.contains(document.activeElement))
      target.append(dockHost);
    if (scroller.current)
      foot.current.style.setProperty(
        "--thread-gutter",
        `${scroller.current.offsetWidth - scroller.current.clientWidth}px`,
      );
    footShown();
  }, [dockHost, footShown]);
  useLayoutEffect(() => {
    placeDock();
    let frame = 0;
    const left = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(placeDock);
    };
    dockHost.addEventListener("focusout", left);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(placeDock);
    if (body.current) observer?.observe(body.current);
    const shown = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(footShown);
    shown?.observe(dockHost);
    return () => {
      cancelAnimationFrame(frame);
      dockHost.removeEventListener("focusout", left);
      observer?.disconnect();
      shown?.disconnect();
    };
  }, [placeDock, footShown, dockHost]);

  // Whether the thread's last row is in view; below it there may only be the foot.
  const history = useRef<HTMLElement>(null);
  const [endSeen, setEndSeen] = useState(true);
  const seeEnd = useCallback(() => {
    const view = scroller.current,
      thread = history.current;
    if (view && thread)
      setEndSeen(thread.getBoundingClientRect().bottom <= view.getBoundingClientRect().bottom + 1);
  }, []);

  // A recovery card that arrives while the reader follows the end is brought into view whole, title
  // first, even when the composer below it fills the rest of the view.
  const recoverySlot = useRef<HTMLDivElement>(null);
  const revealCard = useRef(follow.reveal);
  revealCard.current = follow.reveal;
  const owner = useRef(ownerKey);
  owner.current = ownerKey;
  useLayoutEffect(() => {
    const slot = recoverySlot.current;
    if (!slot || !history.current || typeof ResizeObserver === "undefined") return;
    let card: Element | null = null;
    const observer = new ResizeObserver(() => {
      const now = slot.firstElementChild;
      if (now !== card) setHolding(null);
      if (now instanceof HTMLElement && now !== card && revealCard.current(now, REVEAL_MARGIN))
        setHolding(owner.current);
      card = now;
      seeEnd();
    });
    observer.observe(slot);
    observer.observe(history.current);
    return () => observer.disconnect();
  }, [seeEnd]);
  // The answer panel and the composer differ in height, so while the reader follows the end, one
  // taking the other's place would move the rows above at once. Rows that would rise glide up to the
  // new end instead, and rows that would drop ease down from where they were drawn.
  const asking = !!answer;
  const swapped = useRef(asking);
  const drawnTop = useRef(0);
  if (swapped.current !== asking) drawnTop.current = scroller.current?.scrollTop ?? 0;
  const glideNext = follow.glideNext;
  const following = follow.following;
  useLayoutEffect(() => {
    if (swapped.current === asking) return;
    swapped.current = asking;
    const view = scroller.current,
      thread = history.current;
    if (!view || !thread || !following() || reducedMotion()) return;
    const end = Math.max(0, view.scrollHeight - view.clientHeight);
    const rise = end - drawnTop.current;
    if (rise > 0.5) {
      view.scrollTop = drawnTop.current;
      glideNext();
    } else if (rise < -0.5) {
      view.scrollTop = end;
      easeDown(thread, rise);
    }
  }, [asking, following, glideNext]);

  // Scrolled back only as far as the foot, the reader has nothing newer to jump to.
  const jumpShown = !follow.pinned && (unread.length > 0 || !endSeen);

  const thread: ThreadContext = {
    announce,
    downloads,
    ended,
    pendingAsk,
    latestWork: latestWork?.key,
    onReplay: onReplay && replay,
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
          seeEnd();
          if (dockHost.parentElement === end.current) footShown();
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
            ref={history}
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
            <div className="thread-recovery-slot" ref={recoverySlot}>
              {recovery}
            </div>
            {error && (
              <p className="thread-note thread-error" role="status">
                {error}
              </p>
            )}
          </section>
          <div className="thread-end" ref={end} />
        </div>
      </ScrollArea>
      <span
        className="thread-jump"
        ref={jump}
        data-shown={jumpShown || undefined}
        inert={!jumpShown}
      >
        <Button
          size="sm"
          icon="arrow-down"
          aria-label={unread.length ? unreadLabel(unread) : "Jump to latest"}
          onClick={() => {
            page.latest();
            follow.jump();
          }}
        >
          {unread.length ? `${unread.length} new` : "Latest"}
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
          {answer}
          <div className="thread-composer" hidden={asking}>
            {composer}
          </div>
        </>,
        dockHost,
      )}
    </div>
  );
}
