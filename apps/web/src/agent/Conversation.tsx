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
import { announce as speak, withdraw } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { SentFiles } from "./Attachments.tsx";
import { fileName, splitAttachments } from "./attachments.ts";
import { CopyButton } from "./CopyButton.tsx";
import { type EarlierThread, OPENING_ROWS } from "./earlier.ts";
import { HistoryPages } from "./HistoryPages.tsx";
import { type LiveWork, LiveWorkLine } from "./LiveWorkLine.tsx";
import type { AgentMessage, AgentResult } from "./model.ts";
import { Outbox } from "./outbox.ts";
import { answerText, QuestionCard } from "./QuestionCard.tsx";
import { ResultCard, type ResultDownloads, useResultDownloads } from "./ResultFiles.tsx";
import { SafeMarkdown } from "./SafeMarkdown.tsx";
import { ThreadSkeleton } from "./ThreadSkeleton.tsx";
import {
  type ThreadItem,
  type ThreadKind,
  type ThreadRow,
  threadRows,
  type WorkStep,
} from "./thread.ts";
import { reducedMotion, useFollowScroll } from "./useFollowScroll.ts";
import { usePagedRows } from "./usePagedRows.ts";

// The thread mounts at most this many items, the newest on opening; scrolling to either end moves it
// by half.
const WINDOW = OPENING_ROWS;
// The foot (the live work line and the composer) sits under the thread and stays put while it
// scrolls. Only on a very short column (a phone on its side) does it join the end of the thread
// instead, which keeps one scroller and room to read. Only the column's height decides, so typing, a
// question or a field unfolding never moves the foot; the gap between the two heights covers the
// task bar coming and going.
const FOOT_FROM = 480;
const SUGGESTIONS = [
  "Tidy my Downloads folder",
  "Fill in a spreadsheet from a PDF",
  "Find a table for two on Friday",
];
const END_BELOW = 400;
// A recovery card brought into view sits this far under the scroller's faded top edge.
const REVEAL_MARGIN = 16;
const itemKey = (item: ThreadItem) => item.key;

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
  const spring = style.getPropertyValue("--dur-default").trim();
  const duration = Number.parseFloat(spring) * (spring.endsWith("ms") ? 1 : 1000) || 470;
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
  replayTask?: (sessionId: string) => void;
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
  const { body, files } = user ? splitAttachments(message.text) : { body: message.text, files: [] };
  const copy = (
    <span className="thread-copy-slot" inert={!message.final}>
      <CopyButton
        className="thread-copy"
        text={body}
        label={user ? "Copy your message" : "Copy dot's message"}
        announce={announce}
      />
    </span>
  );
  const tag =
    message.kind === "steer"
      ? "Sent while working"
      : message.queued
        ? "After this task"
        : undefined;
  return (
    <article
      className="thread-message"
      data-role={user ? "user" : "dot"}
      data-streaming={!message.final || undefined}
      aria-label={user ? "You" : "dot"}
    >
      {user ? (
        <>
          <div className="thread-said">
            {copy}
            <p className="thread-bubble">{body}</p>
          </div>
          {files.length > 0 && <SentFiles names={files.map(fileName)} />}
          {tag && <p className="thread-tag">{tag}</p>}
        </>
      ) : (
        <>
          {copy}
          <SafeMarkdown text={message.text} announce={announce} />
        </>
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
    draw: ({ item, thread }) => {
      const earlier = item.result.sessionId;
      const replay = thread.replayTask;
      return (
        <ResultCard
          result={item.result}
          downloads={thread.downloads}
          onReplay={earlier ? replay && (() => replay(earlier)) : thread.onReplay}
        />
      );
    },
    same: (was, now, then, thread) =>
      was.result === now.result &&
      then.downloads === thread.downloads &&
      then.onReplay === thread.onReplay &&
      then.replayTask === thread.replayTask,
  },
  work: {
    draw: ({ item, thread }) => (
      <LiveWorkLine
        steps={item.steps}
        startMs={item.startMs}
        live={null}
        ended={endedOf(item, thread)}
        spend={item.spend}
      />
    ),
    same: (was, now, then, thread) =>
      was.startMs === now.startMs &&
      was.spend?.usd === now.spend?.usd &&
      was.spend?.estimated === now.spend?.estimated &&
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
  // The history the thread opens on is still arriving: it shows message-shaped bones meanwhile, then
  // all of it at once, already at the end.
  loading?: boolean;
  // The conversation's earlier tasks, read in one at a time as the reader scrolls up.
  earlier?: Pick<EarlierThread, "more" | "reading" | "older">;
  // The conversation goes back further than the thread shows.
  earlierInReplay?: boolean;
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
  // Beside the composer, as a phone's toolbar holds it: before it and after it.
  lead?: ReactNode;
  trail?: ReactNode;
  // The composer stays at the foot however short the column gets, as a phone's toolbar does.
  pinned?: boolean;
  // Another view of the task (Activity) laid over the thread, above the foot, so the composer
  // stays put under both.
  cover?: ReactNode;
  covered?: boolean;
  onReplay?: () => void;
  // Opens an earlier task of the conversation in Replay.
  onReplayTask?: (sessionId: string) => void;
  computerReady?: boolean;
  // In place of the empty thread's suggestions, such as the steps setup has left.
  start?: ReactNode;
}

export function Conversation({
  items,
  truncated,
  loading = false,
  earlier,
  earlierInReplay = false,
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
  lead,
  trail,
  pinned = false,
  cover,
  covered = false,
  onReplay,
  onReplayTask,
  computerReady = false,
  start,
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
  // The thread speaks through the page's one polite region, only while it is on show; a task left
  // behind takes back what it had not said yet.
  const heard = useRef(visible);
  heard.current = visible;
  const announce = useCallback((text: string) => {
    if (heard.current) speak("thread", text);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the owner is the trigger.
  useEffect(() => () => withdraw("thread"), [ownerKey]);
  const results = useMemo(
    () => items.flatMap((item) => (item.kind === "result" ? [item.result] : [])) as AgentResult[],
    [items],
  );
  const downloads = useResultDownloads(api, sessionId, results, announce);
  const replayNow = useRef(onReplay);
  replayNow.current = onReplay;
  const replay = useCallback(() => replayNow.current?.(), []);
  const replayTaskNow = useRef(onReplayTask);
  replayTaskNow.current = onReplayTask;
  const replayTask = useCallback((id: string) => replayTaskNow.current?.(id), []);
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
    speak(
      "thread",
      keyLikePresent(message.text) ? "dot replied." : `dot replied: ${message.text.slice(0, 200)}`,
    );
  }, [completed, ownerKey, visible]);

  // The history the thread opens on appears as it is; only items that arrive at the end after it
  // ease in.
  const known = useRef({ owner: ownerKey, keys: new Set<string>(), drawn: false });
  if (known.current.owner !== ownerKey)
    known.current = { owner: ownerKey, keys: new Set(), drawn: false };
  const settled = known.current.drawn;
  const lastKnown = rows.findLastIndex((row) => known.current.keys.has(row.item.key));
  useLayoutEffect(() => {
    if (loading) return;
    for (const row of rows) known.current.keys.add(row.item.key);
    known.current.drawn = true;
  }, [rows, loading]);

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

  const paging = useRef({ page, following: follow.following, jump: follow.jump, earlier });
  paging.current = { page, following: follow.following, jump: follow.jump, earlier };
  const observer = useRef<IntersectionObserver | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  // Reaching either end of the mounted window moves it; the rows in view stay mounted and in place.
  // A page moved by its buttons waits for the reader's own scrolling before the edges move it again.
  const held = useRef(false);
  const reached = useRef({ older: false, newer: false });
  const moveAt = useCallback((edge: "older" | "newer") => {
    const { page: now, following, earlier: tasks } = paging.current;
    if (held.current) return;
    if (edge === "older" && !following()) {
      if (now.hasOlder) now.older();
      else if (tasks?.more && !tasks.reading) tasks.older();
    } else if (edge === "newer" && now.hasNewer) now.newer();
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
  // An earlier task read in while the reader waits at the top comes into the page at once.
  const total = items.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a longer thread is the trigger.
  useEffect(() => {
    if (reached.current.older) moveAt("older");
  }, [total, moveAt]);
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
  const [outboxSlot, setOutboxSlot] = useState<HTMLDivElement | null>(null);
  // Your own message brings the thread's end into view, however far back you were reading.
  const showEnd = useCallback(() => {
    const { page: now, following, jump } = paging.current;
    if (following() && !now.hasNewer) return;
    now.latest();
    jump();
  }, []);
  // A message at the end that waits on your choice turns the jump button into the way to it.
  const reachChoice = useRef<(() => void) | null>(null);
  const [choiceWaits, setChoiceWaits] = useState(false);
  const needs = useCallback((reach: (() => void) | null) => {
    reachChoice.current = reach;
    setChoiceWaits(!!reach);
  }, []);
  const outbox = useMemo(
    () => outboxSlot && { slot: outboxSlot, show: showEnd, needs },
    [outboxSlot, showEnd, needs],
  );
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
  const footHeld = useRef(covered || pinned);
  footHeld.current = covered || pinned;
  const placeDock = useCallback(() => {
    const column = body.current;
    if (!column || !foot.current || !end.current) return;
    const height = column.clientHeight;
    const under = dockHost.parentElement === foot.current;
    const target =
      footHeld.current || height >= FOOT_FROM || (under && height >= END_BELOW)
        ? foot.current
        : end.current;
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
  // A cover or a pinned toolbar keeps the foot under it, so the foot is placed again as one comes
  // or goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: both are read through their ref
  useLayoutEffect(placeDock, [covered, pinned, placeDock]);

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
    replayTask: onReplayTask && replayTask,
  };
  const empty = !shown.length && !liveWork;
  const olderTasks = !!earlier?.more;
  // What setup has left reads from its top; the thread follows its end again once it has gone.
  const startShown = empty && !loading && !!start;
  const followNow = useRef(follow);
  followNow.current = follow;
  useLayoutEffect(() => {
    const view = scroller.current;
    if (!startShown || !view || view.scrollHeight <= view.clientHeight) return;
    followNow.current.release();
    view.scrollTop = 0;
    return () => followNow.current.jump();
  }, [startShown]);
  // A suggestion is put in the composer as if typed, so it is read and checked the same way.
  const suggest = (text: string) => {
    const field = dockHost.querySelector("textarea");
    if (!field || field.readOnly) return;
    field.focus();
    field.setRangeText(text, 0, field.value.length, "end");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return (
    <div className="thread-body" ref={body} data-covered={covered || undefined}>
      <ScrollArea
        ref={attach}
        className="thread-scroll"
        inert={covered}
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
            {(earlierInReplay || truncated) && !page.hasOlder && !olderTasks && !loading && (
              <p className="thread-note thread-start">
                {earlierInReplay
                  ? "Earlier messages are in Replay."
                  : "Earlier messages are kept in the task log."}
              </p>
            )}
            {(page.hasOlder || olderTasks) && !loading && (
              <div className="thread-older" ref={edges.older}>
                {earlier?.reading && <Spinner size={16} label="Loading earlier messages" />}
              </div>
            )}
            <HistoryPages
              older={!loading && (page.hasOlder || olderTasks)}
              newer={!loading && page.hasNewer}
              onOlder={() => {
                held.current = true;
                follow.release();
                if (page.hasOlder) page.older();
                else earlier?.older();
                if (scroller.current) scroller.current.scrollTop = 0;
              }}
              onNewer={() => {
                held.current = true;
                follow.release();
                page.newer();
                if (scroller.current) scroller.current.scrollTop = 0;
              }}
            />
            {loading ? (
              <ThreadSkeleton />
            ) : startShown ? (
              <div className="thread-empty thread-start-steps">{start}</div>
            ) : empty ? (
              <div className="thread-empty">
                <h3>What should we do?</h3>
                <p>
                  {computerReady
                    ? "dot works on its own computer. Watch, step in or stop it at any time."
                    : "Turn on your computer, then ask dot to do something."}
                </p>
                <div className="thread-suggestions">
                  {SUGGESTIONS.map((text) => (
                    <Chip key={text} variant="outline" onClick={() => suggest(text)}>
                      {text}
                    </Chip>
                  ))}
                </div>
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
            <div className="thread-outbox" ref={setOutboxSlot} />
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
      {cover && (
        <div className="thread-cover" inert={!covered}>
          {cover}
        </div>
      )}
      <span
        className="thread-jump"
        ref={jump}
        data-shown={(jumpShown && !covered) || undefined}
        inert={!jumpShown || covered}
      >
        <Button
          size="sm"
          icon="arrow-down"
          aria-label={
            choiceWaits ? undefined : unread.length ? unreadLabel(unread) : "Jump to latest"
          }
          onClick={() => {
            page.latest();
            follow.jump();
            reachChoice.current?.();
          }}
        >
          {choiceWaits
            ? "Check your last message"
            : unread.length
              ? `${unread.length} new`
              : "Latest"}
        </Button>
      </span>
      <div className="thread-foot" ref={foot} />
      {createPortal(
        <Outbox.Provider value={outbox}>
          <Collapse open={!!liveWork && !covered} className="thread-live">
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
          <div className="thread-toolbar">
            {lead}
            <div className="thread-composer" hidden={asking}>
              {composer}
            </div>
            {trail}
          </div>
        </Outbox.Provider>,
        dockHost,
      )}
    </div>
  );
}
