import {
  keyLikePresent,
  microsToMs,
  type PersonaId,
  type ResultPreview,
  type Wearable,
} from "@localdot/protocol";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { count } from "../copy/format.ts";
import { VOICES } from "../dot/voices.ts";
import { t } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { newestOffers, sameOffers } from "../previews/PreviewCard.tsx";
import { RoutineCard } from "../routines/RoutineCard.tsx";
import { originLine } from "../routines/routine-copy.ts";
import { useRoutineSeen } from "../routines/seen.ts";
import type { ModelNames } from "../settings/model-names.ts";
import { announce as speak, withdraw } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { attachLongPress } from "../ui/long-press.ts";
import { fadeIn } from "../ui/motion.ts";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { showToast } from "../ui/Toast.tsx";
import { answerSummary } from "./ask-form.ts";
import { splitAttachments } from "./attachments.ts";
import { type BubbleItem, BubbleMenu, type HeldBubble } from "./BubbleMenu.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { cancelQueuedMessage, steerQueuedMessage } from "./control-api.ts";
import { DotChoice } from "./DotChoice.tsx";
import { type EarlierThread, OPENING_ROWS } from "./earlier.ts";
import { FixLine } from "./FixCards.tsx";
import { HistoryPages } from "./HistoryPages.tsx";
import { type LiveWork, LiveWorkLine, StepsCaption, sameLive, sameSteps } from "./LiveWorkLine.tsx";
import type { AgentMessage, AgentResult, AgentWords } from "./model.ts";
import { Outbox } from "./outbox.ts";
import { QuestionCard } from "./QuestionCard.tsx";
import { QueueHandle, type QueueMoves, useQueueMoves } from "./QueueHandle.tsx";
import { editQueued } from "./queued-draft.ts";
import { ResultCard, type ResultDownloads, useResultDownloads } from "./ResultFiles.tsx";
import { SafeMarkdown } from "./SafeMarkdown.tsx";
import { StepPreviewScope } from "./StepPreview.tsx";
import { ThreadSkeleton } from "./ThreadSkeleton.tsx";
import { metaLine, TurnMeta } from "./TurnMeta.tsx";
import {
  controlLine,
  type ThreadItem,
  type ThreadKind,
  type ThreadRow,
  threadRows,
  timeLabel,
} from "./thread.ts";
import { UserBubble } from "./UserBubble.tsx";
import { copyBlocked } from "./useCopy.ts";
import { REVEAL_MARGIN, useFollowScroll } from "./useFollowScroll.ts";
import { type KeptRows, usePagedRows } from "./usePagedRows.ts";

// The thread mounts about this many items, the newest on opening; scrolling near either end moves it
// by half, keeping every row within reach of the view.
const WINDOW = OPENING_ROWS;
// Rows come in this far ahead of the view, so a flick rarely lands on the page's edge...
const EDGE_PX = 600;
// ...and go only past this, further than the edge, so a page never moves back and forth.
const KEEP_PX = 1200;
// The foot (the live work line and the composer) sits under the thread and stays put while it
// scrolls. Only on a very short column (a phone on its side) does it join the end of the thread
// instead, which keeps one scroller and room to read. Only the column's height decides, so typing or
// a field unfolding never moves the foot; the gap between the two heights covers the task bar
// coming and going.
const FOOT_FROM = 480;
const END_BELOW = 400;
const NONE: readonly string[] = [];
const itemKey = (item: ThreadItem) => item.key;
const rowKey = (row: ThreadRow) => row.item.key;

const pageRows = (view: HTMLElement) =>
  view.querySelectorAll<HTMLElement>(".thread > .thread-row[data-row]:not([data-waiting])");

// The first and last rows within reach of the view.
function rowsInReach(view: HTMLElement | null): KeptRows {
  const reach: KeptRows = {};
  if (!view) return reach;
  const box = view.getBoundingClientRect();
  for (const row of pageRows(view)) {
    const at = row.getBoundingClientRect();
    if (at.bottom < box.top - KEEP_PX || at.top > box.bottom + KEEP_PX) continue;
    reach.first ??= row.dataset.row;
    reach.last = row.dataset.row;
  }
  return reach;
}

// The first of the rows that fill the view at the thread's end.
function rowsAtEnd(view: HTMLElement | null): KeptRows {
  if (!view) return {};
  const rows = [...pageRows(view)];
  const bottom = rows.at(-1)?.getBoundingClientRect().bottom ?? 0;
  const first = rows.find((row) => bottom - row.getBoundingClientRect().top < view.clientHeight);
  return { first: (first?.previousElementSibling as HTMLElement | null)?.dataset.row };
}

// What the jump button says has arrived: one kind by its name, a mix as updates. Your answers are
// messages too.
const MESSAGES = (n: number) => count(n, "new message", "new messages");
const NEW: Partial<Record<ThreadKind, (n: number) => string>> = {
  message: MESSAGES,
  answer: MESSAGES,
  question: (n) => count(n, "new question", "new questions"),
  result: (n) => count(n, "new result", "new results"),
  routine: (n) => count(n, "new routine", "new routines"),
};
const UPDATES = (n: number) => count(n, "new update", "new updates");
function unreadLabel(kinds: readonly ThreadKind[]): string {
  const nouns = new Set(kinds.map((kind) => NEW[kind]));
  const said = (nouns.size === 1 && [...nouns][0]) || UPDATES;
  return said(kinds.length);
}

const SWITCH_ARMED_MS = 5000;

interface QueueActions {
  api: ApiClient;
  sessionId: string;
}
interface ThreadContext {
  queue?: QueueActions;
  moves: QueueMoves;
  // Puts a message Stop left unsent back into the composer.
  takeBack(message: AgentMessage): Promise<boolean> | null;
  announce(text: string): void;
  words?: AgentWords;
  downloads: ResultDownloads;
  // How many results the thread holds: another one changes the versions of files already shown.
  results: number;
  // The previews each reply comes with.
  offers: ReadonlyMap<string, readonly ResultPreview[]>;
  ended?: "done" | "stopped" | "interrupted" | "error";
  pendingAsk: string | null;
  // The fields of the question dot is waiting on, drawn under it.
  ask?: ReactNode;
  latestWork: string | undefined;
  // The conversation's latest dot choice, which the task at work can change.
  latestDot: string | undefined;
  dotLook(persona: PersonaId): readonly Wearable[];
  // What dot is doing now, for the latest run of steps while its task has not ended.
  live: LiveWork | null;
  onReplay?: () => void;
  replayTask?: (sessionId: string, atMs?: number) => void;
  names?: ModelNames;
  // A chat's bubbles: a finger held on one opens its menu, and each turn's steps fold under a caption.
  chat?: {
    hold(message: AgentMessage, from: HTMLElement): void;
    opened: ReadonlySet<string>;
    toggle(key: string, open: boolean): void;
  };
}
type ItemOf<K extends ThreadKind> = Extract<ThreadItem, { kind: K }>;
type WorkItem = ItemOf<"work">;
// One kind of row in the thread: how it draws, and whether an item rebuilt by a later event still
// draws as it did, so the row need not redraw.
interface CardKind<K extends ThreadKind> {
  draw(props: { item: ItemOf<K>; thread: ThreadContext }): ReactNode;
  same(was: ItemOf<K>, now: ItemOf<K>, then: ThreadContext, thread: ThreadContext): boolean;
}

// A message still arriving reads its newest words from the feed when it says they came, so the
// page does not draw again for them.
function useArriving(words: AgentWords | undefined, shown: AgentMessage): AgentMessage {
  const feed = shown.final ? undefined : words;
  const subscribe = useCallback(
    (listener: () => void) => feed?.subscribeWords(listener) ?? (() => {}),
    [feed],
  );
  return useSyncExternalStore(subscribe, () => feed?.read().model.messages.get(shown.id) ?? shown);
}

const MessageCard = memo(function MessageCard({
  message: shown,
  narration = false,
  words,
  announce,
  queue,
  moves,
  takeBack,
  sessionId,
  onHold,
}: {
  queue?: QueueActions;
  moves?: QueueMoves;
  takeBack(message: AgentMessage): Promise<boolean> | null;
  message: AgentMessage;
  // dot's words before more of its work, which read quieter than its answer.
  narration?: boolean;
  words?: AgentWords;
  announce(text: string): void;
  // The task the message went to, whose computer holds the files it carried.
  sessionId?: string;
  onHold?(message: AgentMessage, from: HTMLElement): void;
}) {
  const message = useArriving(words, shown);
  const user = message.role === "user";
  const card = useRef<HTMLElement>(null);
  const latest = useRef({ message, onHold });
  latest.current = { message, onHold };
  const holds = !!onHold;
  const [holding, setHolding] = useState(false);
  useEffect(() => {
    const element = card.current;
    if (!element || !holds) return;
    return attachLongPress(element, {
      pressing: setHolding,
      hold: () => {
        const from = element.querySelector<HTMLElement>(".thread-bubble") ?? element;
        latest.current.onHold?.(latest.current.message, from);
      },
    });
  }, [holds]);
  const { body, files } = user ? splitAttachments(message.text) : { body: message.text, files: [] };
  const copy = (
    <span className="thread-copy-slot" inert={!message.final}>
      <CopyButton
        className="thread-copy"
        text={body}
        label={user ? t`Copy your message` : t`Copy dot's message`}
        announce={announce}
      />
    </span>
  );
  const tag = message.stopped
    ? t`Not sent`
    : message.interrupted === "wait"
      ? t`dot stopped waiting to read this`
      : message.interrupted === "command"
        ? t`dot left its command running to read this`
        : message.kind === "steer"
          ? t`Sent while working`
          : message.queued
            ? message.waitsFor
              ? t`After this task, on another model`
              : t`After this task`
            : undefined;
  return (
    <article
      ref={card}
      className="thread-message"
      data-role={user ? "user" : "dot"}
      data-narration={narration || undefined}
      data-streaming={!message.final || undefined}
      data-holding={holding || undefined}
      aria-label={user ? t`You` : "dot"}
    >
      {user ? (
        <>
          <UserBubble
            text={body}
            files={files}
            lead={body.trim() ? copy : null}
            sessionId={message.sessionId ?? sessionId}
          />
          {tag && (
            <div className="thread-queue">
              {moves && moves.order.length > 1 && moves.order.includes(message.id) && (
                <QueueHandle id={message.id} moves={moves} announce={announce} />
              )}
              <p className="thread-tag">{tag}</p>
              {message.queued && queue && message.sessionId === queue.sessionId && (
                <SteerMessage
                  messageId={message.id}
                  waitsFor={message.waitsFor}
                  queue={queue}
                  announce={announce}
                />
              )}
              {message.stopped && <TakeBack onTakeBack={() => takeBack(message)} />}
            </div>
          )}
        </>
      ) : (
        <>
          {copy}
          <SafeMarkdown text={message.text} streaming={!message.final} announce={announce} />
        </>
      )}
      {message.truncated && <p className="thread-note">{t`Message preview shortened.`}</p>}
    </article>
  );
});

const endedOf = (item: WorkItem, thread: ThreadContext) =>
  item.key === thread.latestWork ? thread.ended : undefined;
const liveOf = (item: WorkItem, thread: ThreadContext) =>
  item.key === thread.latestWork ? thread.live : null;

function SteerMessage({
  messageId,
  waitsFor,
  queue,
  announce,
}: {
  messageId: string;
  waitsFor?: AgentMessage["waitsFor"];
  queue: QueueActions;
  announce(text: string): void;
}) {
  const [busy, setBusy] = useState(false);
  // Switching model restarts dot, which ends what it has running, so it takes a second press.
  const [arming, setArming] = useState(false);
  useEffect(() => {
    if (!arming) return;
    const timer = setTimeout(() => setArming(false), SWITCH_ARMED_MS);
    return () => clearTimeout(timer);
  }, [arming]);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => () => lifetime.current?.abort(), []);
  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        disabledReason={busy ? t`Updating message…` : undefined}
        onClick={() => {
          if (pending.current) return;
          // The composer takes the message back, and says how that went; this row leaves once
          // dot has given it back.
          const taking = editQueued(queue.sessionId, messageId);
          if (!taking) {
            setError(t`Couldn't move this message to the composer. Try again.`);
            return;
          }
          pending.current = true;
          setBusy(true);
          setError(null);
          const abort = new AbortController();
          lifetime.current = abort;
          void taking.finally(() => {
            pending.current = false;
            if (!abort.signal.aborted) setBusy(false);
          });
        }}
      >
        {t`Edit`}
      </Button>
      {waitsFor !== "handover" && (
        <Button
          variant="quiet"
          size="sm"
          busy={busy}
          onClick={() => {
            if (pending.current) return;
            if (waitsFor === "switch" && !arming) {
              setArming(true);
              announce(t`Switching now ends what dot is running. Press again to switch.`);
              return;
            }
            setArming(false);
            pending.current = true;
            setBusy(true);
            setError(null);
            const abort = new AbortController();
            lifetime.current = abort;
            void steerQueuedMessage(queue.api, queue.sessionId, messageId, abort.signal)
              .then(() => {
                if (!abort.signal.aborted) announce(t`Message sent to steer dot.`);
              })
              .catch(() => {
                if (!abort.signal.aborted) setError(t`Couldn't confirm steering. Try again.`);
              })
              .finally(() => {
                pending.current = false;
                if (!abort.signal.aborted) setBusy(false);
              });
          }}
        >
          {waitsFor !== "switch"
            ? t`Steer now`
            : arming
              ? t`End what's running and switch`
              : t`Switch now`}
        </Button>
      )}
      <Button
        variant="quiet"
        size="sm"
        disabledReason={busy ? t`Updating message…` : undefined}
        onClick={() => {
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          setError(null);
          const abort = new AbortController();
          lifetime.current = abort;
          void cancelQueuedMessage(queue.api, queue.sessionId, messageId, abort.signal)
            .then(() => {
              if (!abort.signal.aborted) announce(t`Queued message cancelled.`);
            })
            .catch(() => {
              if (!abort.signal.aborted)
                setError(t`Couldn't cancel this message. It may have started already. Try again.`);
            })
            .finally(() => {
              pending.current = false;
              if (!abort.signal.aborted) setBusy(false);
            });
        }}
      >
        {t`Cancel`}
      </Button>
      {error && (
        <span className="thread-note" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

// Edit on a message Stop left unsent; the row leaves once its words are in the composer.
function TakeBack({ onTakeBack }: { onTakeBack(): Promise<boolean> | null }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        onClick={() => {
          setError(null);
          if (!onTakeBack()) setError(t`Couldn't move this message to the composer. Try again.`);
        }}
      >
        {t`Edit`}
      </Button>
      {error && (
        <span className="thread-note" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function sameMeta(was: ItemOf<"meta"> | undefined, now: ItemOf<"meta"> | undefined): boolean {
  if (!was || !now) return was === now;
  return (
    was.work === now.work &&
    was.durationMs === now.durationMs &&
    was.usd === now.usd &&
    was.main?.route === now.main?.route &&
    was.main?.model === now.main?.model &&
    JSON.stringify(was.models) === JSON.stringify(now.models)
  );
}

const CARDS: { [K in ThreadKind]: CardKind<K> } = {
  message: {
    draw: ({ item, thread }) => (
      <MessageCard
        message={item.message}
        narration={item.narration}
        words={thread.words}
        announce={thread.announce}
        queue={thread.queue}
        moves={thread.moves}
        takeBack={thread.takeBack}
        sessionId={thread.downloads.sessionId ?? undefined}
        onHold={thread.chat?.hold}
      />
    ),
    same: (was, now, then, thread) =>
      was.message === now.message &&
      was.narration === now.narration &&
      then.chat?.hold === thread.chat?.hold &&
      then.announce === thread.announce &&
      then.words === thread.words &&
      then.queue === thread.queue &&
      then.moves === thread.moves &&
      then.takeBack === thread.takeBack &&
      then.downloads.sessionId === thread.downloads.sessionId,
  },
  question: {
    draw: ({ item, thread }) => (
      <QuestionCard
        question={item.question}
        pending={thread.pendingAsk === item.question.askId}
        form={thread.pendingAsk === item.question.askId ? thread.ask : undefined}
      />
    ),
    same: (was, now, then, thread) =>
      was.question === now.question &&
      (then.pendingAsk === was.question.askId) === (thread.pendingAsk === now.question.askId) &&
      (thread.pendingAsk !== now.question.askId || then.ask === thread.ask),
  },
  unapproved: {
    draw: ({ item }) => (
      <article className="thread-question" aria-label={t`Not approved`}>
        <p className="thread-question-text">{item.title}</p>
        <p className="thread-note">
          {t`Not approved: you sent a message instead, so it didn't run.`}
        </p>
      </article>
    ),
    same: (was, now) => was.title === now.title,
  },
  answer: {
    draw: ({ item }) => (
      <article className="thread-message" data-role="user" aria-label={t`Your answer`}>
        <p className="thread-bubble">{answerSummary(item.question)}</p>
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
          refresh={thread.results}
          onReplay={earlier ? replay && (() => replay(earlier)) : thread.onReplay}
          previews={thread.offers.get(item.result.id)}
        />
      );
    },
    same: (was, now, then, thread) =>
      was.result === now.result &&
      then.downloads === thread.downloads &&
      then.results === thread.results &&
      sameOffers(then.offers.get(was.result.id), thread.offers.get(now.result.id)) &&
      then.onReplay === thread.onReplay &&
      then.replayTask === thread.replayTask,
  },
  routine: {
    draw: ({ item }) => <RoutineCard proposal={item.proposal} />,
    same: (was, now) => was.proposal === now.proposal,
  },
  dot: {
    draw: ({ item, thread }) => (
      <DotChoice
        choice={item.choice}
        wearables={thread.dotLook(item.choice.persona)}
        task={item.key === thread.latestDot ? thread.queue : undefined}
      />
    ),
    same: (was, now, then, thread) =>
      was.choice === now.choice &&
      then.dotLook(was.choice.persona).join(" ") === thread.dotLook(now.choice.persona).join(" ") &&
      (was.key === then.latestDot ? then.queue : undefined) ===
        (now.key === thread.latestDot ? thread.queue : undefined),
  },
  origin: {
    draw: ({ item }) => (
      <p className="thread-divider">
        <span>{originLine(item.origin)}</span>
      </p>
    ),
    same: (was, now) => was.origin.runId === now.origin.runId,
  },
  control: {
    draw: ({ item }) => (
      <p className="thread-divider">
        <span>
          {controlLine(item)}
          {item.at !== undefined && <time className="num"> · {timeLabel(item.at)}</time>}
        </span>
      </p>
    ),
    same: (was, now) =>
      was.took === now.took &&
      was.at === now.at &&
      was.handed === now.handed &&
      was.declined === now.declined &&
      was.movedOn === now.movedOn,
  },
  fix: {
    draw: ({ item, thread }) => <FixLine blocker={item.blocker} names={thread.names} />,
    same: (was, now, then, thread) => was.blocker === now.blocker && then.names === thread.names,
  },
  work: {
    draw: ({ item, thread }) =>
      thread.chat ? (
        <StepsCaption
          steps={item.steps}
          startMs={item.startMs}
          at={item.at === undefined ? undefined : timeLabel(item.at)}
          ended={endedOf(item, thread)}
          sessionId={item.sessionId}
          names={thread.names}
          open={thread.chat.opened.has(item.key)}
          onOpenChange={(open) => thread.chat?.toggle(item.key, open)}
        >
          {item.meta && <TurnMeta item={item.meta} names={thread.names} />}
        </StepsCaption>
      ) : (
        <LiveWorkLine
          steps={item.steps}
          startMs={item.startMs}
          live={liveOf(item, thread)}
          ended={endedOf(item, thread)}
          spend={item.spend}
          sessionId={item.sessionId}
          changedTo={item.changedTo}
          names={thread.names}
        />
      ),
    same: (was, now, then, thread) =>
      then.names === thread.names &&
      was.at === now.at &&
      then.chat?.opened.has(was.key) === thread.chat?.opened.has(now.key) &&
      sameMeta(was.meta, now.meta) &&
      was.changedTo?.route === now.changedTo?.route &&
      was.changedTo?.model === now.changedTo?.model &&
      was.startMs === now.startMs &&
      was.sessionId === now.sessionId &&
      was.spend?.usd === now.spend?.usd &&
      was.spend?.estimated === now.spend?.estimated &&
      endedOf(was, then) === endedOf(now, thread) &&
      sameLive(liveOf(was, then), liveOf(now, thread)) &&
      sameSteps(was.steps, now.steps),
  },
  meta: {
    draw: ({ item, thread }) => <TurnMeta item={item} names={thread.names} />,
    same: (was, now, then, thread) => then.names === thread.names && sameMeta(was, now),
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
  // Held at the end of the thread until dot receives it, outside the page of rows.
  waiting?: boolean;
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

const Row = memo(function Row({ row, fresh, thread, waiting }: RowProps) {
  const { item } = row;
  return (
    <div
      className="thread-row"
      data-anchor=""
      data-row={item.key}
      data-kind={item.kind}
      data-speaker={item.speaker}
      data-group-start={row.groupStart || undefined}
      data-new={fresh || undefined}
      data-waiting={waiting || undefined}
    >
      {row.separator && (
        <p className="thread-time">
          <time>{row.separator}</time>
        </p>
      )}
      <Card item={item} thread={thread} />
    </div>
  );
}, sameRow);

// What a held bubble offers. iOS's long press fights text selection, so Select text opens a sheet
// the text can be selected in.
function heldBubble(
  message: AgentMessage,
  from: HTMLElement,
  {
    shown,
    opened,
    sessionId,
    ended,
    names,
  }: {
    shown: readonly ThreadItem[];
    opened: ReadonlySet<string>;
    sessionId: string | null;
    ended?: string;
    names?: ModelNames;
  },
  act: {
    select(text: string): void;
    toggleSteps(key: string, open: boolean): void;
    again(text: string): void;
    replay(sessionId: string, atMs?: number): void;
    canReplay: boolean;
  },
): HeldBubble {
  const user = message.role === "user";
  const text = user ? splitAttachments(message.text).body : message.text;
  const copy: BubbleItem = {
    label: t`Copy`,
    icon: "copy",
    run: () => {
      const blocked = copyBlocked(text);
      if (blocked) {
        showToast({ title: blocked, tone: "danger" });
        return;
      }
      navigator.clipboard.writeText(text).then(
        () => showToast({ title: t`Copied` }),
        () => showToast({ title: t`Couldn't copy`, tone: "danger" }),
      );
    },
  };
  if (user)
    return {
      from,
      mine: true,
      items: [copy, { label: t`Edit and send again`, icon: "compose", run: () => act.again(text) }],
    };
  const at = shown.findIndex((item) => item.kind === "message" && item.message.id === message.id);
  const own = at >= 0 ? (shown[at] as Extract<ThreadItem, { kind: "message" }>) : undefined;
  const rest = at >= 0 ? shown.slice(at + 1) : [];
  const nextTurn = rest.findIndex((item) => item.speaker === "user" && item.kind === "message");
  const steps = (nextTurn >= 0 ? rest.slice(0, nextTurn) : rest).find(
    (item): item is Extract<ThreadItem, { kind: "work" }> => item.kind === "work",
  );
  const line = steps?.meta ?? own?.turnLine;
  const when = own?.time === undefined ? undefined : timeLabel(own.time);
  const note = [when, line && metaLine(line, names)].filter(Boolean).join(" · ");
  const task = steps?.sessionId ?? message.sessionId ?? sessionId;
  const finished = !!ended || act.canReplay || (!!task && task !== sessionId);
  const open = !!steps && opened.has(steps.key);
  return {
    from,
    mine: false,
    ...(note ? { note } : {}),
    items: [
      copy,
      { label: t`Select text`, icon: "type", run: () => act.select(text) },
      ...(steps?.steps.length
        ? [
            {
              label: open ? t`Hide steps` : t`Show steps`,
              icon: "list" as const,
              run: () => act.toggleSteps(steps.key, !open),
            },
          ]
        : []),
      ...(steps?.steps.length && task && finished
        ? [
            {
              label: t`Watch this part`,
              icon: "history" as const,
              run: () =>
                act.replay(
                  task,
                  steps.startMs ?? (message.at === undefined ? undefined : microsToMs(message.at)),
                ),
            },
          ]
        : []),
      {
        label: t`Share`,
        icon: "share" as const,
        run: () => {
          if (typeof navigator.share === "function") void navigator.share({ text }).catch(() => {});
          else copy.run();
        },
      },
    ],
  };
}

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
  // Messages Stop left unsent that the user has taken back to edit, on any device.
  withdrawn?: readonly string[];
  visible?: boolean;
  ownerKey?: string;
  // What dot is doing now, while its task has not ended.
  live?: LiveWork | null;
  ended?: "done" | "stopped" | "interrupted" | "error";
  pendingAsk?: string | null;
  // The order of the messages waiting for the task to finish, once one has moved.
  queueOrder?: readonly string[];
  api?: ApiClient | null;
  sessionId?: string | null;
  // The computer's display scale, for the screenshots a step unfolds.
  scale?: number;
  recovery?: ReactNode;
  // Under the thread: the composer, always in its place, so a draft survives and nothing moves.
  composer?: ReactNode;
  // Above the composer: what waits for the user's choice while dot goes on, so it can't scroll away.
  decisions?: ReactNode;
  // The fields of the question dot is waiting on, drawn under the question in the thread.
  ask?: ReactNode;
  // Beside the composer, as a phone's toolbar holds it: before it and after it.
  lead?: ReactNode;
  trail?: ReactNode;
  // In the toolbar's place, the composer and what is beside it hidden but kept, so a draft survives.
  tools?: ReactNode;
  // A phone's chat: replies are bubbles, held for their menu, and each turn's steps fold under them.
  chat?: boolean;
  // The foot of the thread, under its last row: dot and what it is doing.
  foot?: ReactNode;
  // Elsewhere the composer and the decisions go for now, keeping what is written.
  dockTo?: HTMLElement | null;
  // The composer stays at the foot however short the column gets, as a phone's toolbar does.
  pinned?: boolean;
  // Another view of the task (Activity) laid over the thread, above the foot, so the composer
  // stays put under both.
  cover?: ReactNode;
  covered?: boolean;
  onReplay?: () => void;
  // Opens an earlier task of the conversation in Replay, at a moment when given.
  onReplayTask?: (sessionId: string, atMs?: number) => void;
  computerReady?: boolean;
  // The computer is moving onto a new version and is back in about a minute.
  computerUpdating?: boolean;
  // What an empty thread offers to start with; the everyday dot's by default.
  suggestions?: readonly string[];
  // In place of the empty thread's suggestions, such as the steps setup has left.
  start?: ReactNode;
  // Counts the conversations the user chose: each one's thread comes in anew.
  reveal?: number;
  words?: AgentWords;
  // Names the models the turns' lines report.
  names?: ModelNames;
  // The conversation's look as each dot, which its lines naming a dot wear.
  dotLook?: (persona: PersonaId) => readonly Wearable[];
}

const PLAIN_DOT = () => [];

export function Conversation({
  items,
  truncated,
  loading = false,
  earlier,
  earlierInReplay = false,
  withdrawn = NONE,
  visible = true,
  ownerKey = "",
  live = null,
  ended,
  pendingAsk = null,
  queueOrder,
  api = null,
  sessionId = null,
  scale,
  recovery,
  composer,
  decisions,
  ask,
  lead,
  trail,
  tools,
  chat = false,
  foot: threadFoot,
  dockTo = null,
  pinned = false,
  cover,
  covered = false,
  onReplay,
  onReplayTask,
  computerReady = false,
  computerUpdating = false,
  suggestions = VOICES.everyday.suggestions,
  start,
  reveal = 0,
  words,
  names,
  dotLook = PLAIN_DOT,
}: ConversationProps) {
  // The latest run of steps, which shows what dot is doing while its task is live.
  const latestWork = items.findLast((item) => item.kind === "work") as WorkItem | undefined;
  // Messages Stop left unsent that the user took back into the composer here; `withdrawn` names
  // those taken back before, here or on another device.
  const [taken, setTaken] = useState<ReadonlySet<string>>(() => new Set());
  const takeBack = useCallback(
    (message: AgentMessage) =>
      editQueued(message.sessionId ?? "", message.id, true)?.then((done) => {
        if (done) setTaken((was) => new Set(was).add(message.id));
        return done;
      }) ?? null,
    [],
  );
  // A message that waits for the task to finish stays at the end of the thread, under whatever dot
  // does meanwhile, until dot receives it and it takes its place in the thread.
  const [shown, waiting] = useMemo(() => {
    const waits = (item: ThreadItem) =>
      item.kind === "message" &&
      !!item.message.queued &&
      !ended &&
      item.message.sessionId === sessionId;
    const gone = (id: string) => taken.has(id) || withdrawn.includes(id);
    const kept = items.filter((item) => !(item.kind === "message" && gone(item.message.id)));
    return [kept.filter((item) => !waits(item)), kept.filter(waits)];
  }, [items, ended, sessionId, taken, withdrawn]);
  const moves = useQueueMoves(
    api,
    sessionId,
    queueOrder,
    useMemo(
      () => waiting.flatMap((item) => (item.kind === "message" ? item.message.id : [])),
      [waiting],
    ),
  );
  const queued = useMemo(
    () =>
      [...waiting].sort(
        (a, b) =>
          moves.order.indexOf(a.kind === "message" ? a.message.id : "") -
          moves.order.indexOf(b.kind === "message" ? b.message.id : ""),
      ),
    [waiting, moves.order],
  );
  // A row draws the same wherever the page starts: its time and its group come from the whole thread.
  const allRows = useMemo(() => threadRows(shown), [shown]);
  const page = usePagedRows(allRows, rowKey, ownerKey, { size: WINDOW, step: WINDOW / 2 });
  // Following the end, the end is held in the same frame as anything arrives, so nothing at the
  // end moves; a new row eases in where it lands instead.
  const pageEnds = useRef(true);
  pageEnds.current = !page.hasNewer;
  const follow = useFollowScroll(
    ownerKey,
    true,
    useCallback(() => pageEnds.current, []),
  );
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
  const offers = useMemo(() => newestOffers(results), [results]);
  const origin = items.find((item): item is ItemOf<"origin"> => item.kind === "origin")?.origin;
  useRoutineSeen(api, origin?.kind === "routine" ? origin.routineId : undefined, visible);
  const replayNow = useRef(onReplay);
  replayNow.current = onReplay;
  const replay = useCallback(() => replayNow.current?.(), []);
  const replayTaskNow = useRef(onReplayTask);
  replayTaskNow.current = onReplayTask;
  const replayTask = useCallback(
    (id: string, atMs?: number) => replayTaskNow.current?.(id, atMs),
    [],
  );
  const rows = page.rows;

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
      keyLikePresent(message.text)
        ? t`dot replied.`
        : t`dot replied: ${message.text.slice(0, 200)}`,
    );
  }, [completed, ownerKey, visible]);

  // The history the thread opens on appears as it is; only items that arrive at the end after it
  // ease in.
  const known = useRef({ owner: ownerKey, keys: new Set<string>(), drawn: false });
  if (known.current.owner !== ownerKey)
    known.current = { owner: ownerKey, keys: new Set(), drawn: false };
  const settled = known.current.drawn;
  // Older pages come in above the first row the reader has seen; what arrives comes after it, often
  // above the run dot is at, which stays the thread's last row.
  const firstKnown = rows.findIndex((row) => known.current.keys.has(row.item.key));
  // Rows that came while the reader was away, and those a page brings in, are history by then.
  const arriving = page.following && !page.retained;
  useLayoutEffect(() => {
    if (loading) return;
    for (const row of arriving ? rows : allRows) known.current.keys.add(row.item.key);
    known.current.drawn = true;
  }, [rows, allRows, arriving, loading]);

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
        .filter((item) => item.kind !== "work" && item.kind !== "meta" && !left.keys.has(item.key))
        .map((item) => item.kind)
    : [];

  const olderTasksOpen = !!earlier?.more;
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
    const view = scroller.current;
    if (held.current || !view) return;
    if (edge === "newer") {
      if (now.hasNewer) now.newer(rowsInReach(view));
      return;
    }
    // Following the end, only a thread too short to scroll back through reads further back.
    if (following() && view.scrollHeight - view.clientHeight > EDGE_PX) return;
    if (now.hasOlder) {
      if (following() && now.following) now.fill();
      else now.older(rowsInReach(view));
    } else if (tasks?.more && !tasks.reading) tasks.older();
  }, []);
  const edgeNodes = useRef<{ older: HTMLElement | null; newer: HTMLElement | null }>({
    older: null,
    newer: null,
  });
  const edges = useMemo(() => {
    const watch = (edge: "older" | "newer") => (element: HTMLElement | null) => {
      edgeNodes.current[edge] = element;
      if (!element) return;
      element.dataset.edge = edge;
      observer.current?.observe(element);
      return () => {
        reached.current[edge] = false;
        edgeNodes.current[edge] = null;
        observer.current?.unobserve(element);
      };
    };
    return { older: watch("older"), newer: watch("newer") };
  }, []);
  // Child refs attach before the scroll root. Connect after all refs exist, and reconnect
  // after effect cleanup instead of retaining a disconnected observer.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !scroller.current) return;
    const watching = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const edge = (entry.target as HTMLElement).dataset.edge as "older" | "newer";
          reached.current[edge] = entry.isIntersecting;
          if (entry.isIntersecting) moveAt(edge);
        }
      },
      { root: scroller.current, rootMargin: `${EDGE_PX}px 0px` },
    );
    observer.current = watching;
    for (const node of Object.values(edgeNodes.current)) if (node) watching.observe(node);
    return () => {
      watching.disconnect();
      observer.current = null;
      reached.current = { older: false, newer: false };
    };
  }, [moveAt]);
  // Replacing a page can leave an edge's marker within reach throughout, and IntersectionObserver
  // does not notify again for that. Re-measure both after page progress; a page goes on only if
  // its marker is STILL near the view once the reader's place has been kept.
  const lastPageKey = rows.at(-1)?.item.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: page boundaries trigger a fresh geometry observation.
  useEffect(() => {
    for (const node of Object.values(edgeNodes.current)) {
      if (!node) continue;
      observer.current?.unobserve(node);
      observer.current?.observe(node);
    }
  }, [page.start, lastPageKey, olderTasksOpen]);
  const reading = () => {
    setHolding(null);
    if (!held.current) return;
    held.current = false;
    if (reached.current.older) moveAt("older");
    else if (reached.current.newer) moveAt("newer");
  };
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
  const readingBack = useCallback(() => {
    if (reached.current.older) moveAt("older");
  }, [moveAt]);
  // Back at the true end, the reader follows it: the page takes the newest rows from now on.
  const backAtEnd = follow.pinned && !page.following && !page.hasNewer;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the moment the reader is back is the trigger.
  useLayoutEffect(() => {
    if (backAtEnd) page.latest(rowsAtEnd(scroller.current));
  }, [backAtEnd]);
  // A message at the end that waits on your choice turns the jump button into the way to it.
  const reachChoice = useRef<(() => void) | null>(null);
  const [choiceWaits, setChoiceWaits] = useState(false);
  const needs = useCallback((reach: (() => void) | null) => {
    reachChoice.current = reach;
    setChoiceWaits(!!reach);
  }, []);
  const foot = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const jump = useRef<HTMLSpanElement>(null);
  const [dockHost] = useState(() => {
    const host = document.createElement("div");
    host.className = "thread-dock";
    return host;
  });
  // The computer handed over mid-sentence: its controls take the field's place once the user
  // leaves it. Called up from those controls, the field stays while it has words to send.
  const [writing, setWriting] = useState(false);
  const calledUp = useRef(false);
  const write = useCallback(() => {
    calledUp.current = true;
    flushSync(() => setWriting(true));
    dockHost.querySelector("textarea")?.focus();
  }, [dockHost]);
  useEffect(() => {
    const changed = ({ target }: FocusEvent) => {
      const field = dockHost.querySelector("textarea");
      if (target === field && document.activeElement !== field && !field?.value.trim())
        calledUp.current = false;
      setWriting(document.activeElement === field || calledUp.current);
    };
    dockHost.addEventListener("focusin", changed);
    dockHost.addEventListener("focusout", changed);
    return () => {
      dockHost.removeEventListener("focusin", changed);
      dockHost.removeEventListener("focusout", changed);
    };
  }, [dockHost]);
  const controls = writing ? null : tools;
  // A sent message gives back the lines the composer grew by. While the reader follows the end, the
  // foot keeps that room until the thread grows again, so the message just sent never drops.
  const following = useRef(follow.pinned);
  following.current = follow.pinned;
  const keep = useCallback(() => {
    const element = foot.current;
    if (element && following.current && dockHost.parentElement === element)
      element.style.minHeight = `${element.offsetHeight}px`;
  }, [dockHost]);
  const outbox = useMemo(
    () => outboxSlot && { slot: outboxSlot, show: showEnd, needs, keep, write },
    [outboxSlot, showEnd, needs, keep, write],
  );
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
  const dockAway = useRef(dockTo);
  dockAway.current = dockTo;
  const placeDock = useCallback(() => {
    const column = body.current;
    if (!column || !foot.current || !end.current) return;
    const height = column.clientHeight;
    const under = dockHost.parentElement === foot.current;
    const target =
      dockAway.current ??
      (footHeld.current || height >= FOOT_FROM || (under && height >= END_BELOW)
        ? foot.current
        : end.current);
    // Moving an element takes the focus out of it, so the foot moves once the focus has left it.
    if (dockHost.parentElement !== target && !dockHost.contains(document.activeElement))
      target.append(dockHost);
    if (dockHost.parentElement !== foot.current) foot.current.style.removeProperty("min-height");
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
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(left);
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
  useLayoutEffect(placeDock, [covered, pinned, dockTo, placeDock]);

  // Whether the thread's last row is in view; below it there may only be the foot.
  const history = useRef<HTMLElement>(null);
  const [endSeen, setEndSeen] = useState(true);
  const seeEnd = useCallback(() => {
    const view = scroller.current,
      thread = history.current;
    if (view && thread)
      setEndSeen(thread.getBoundingClientRect().bottom <= view.getBoundingClientRect().bottom + 1);
  }, []);

  // The room kept for a sent message goes once the thread has grown, a frame after, so the end the
  // thread follows takes the room back with its new rows.
  useLayoutEffect(() => {
    const element = foot.current,
      thread = history.current;
    if (!element || !thread || typeof ResizeObserver === "undefined") return;
    let height = thread.offsetHeight;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      const now = thread.offsetHeight;
      if (now > height + 1 && element.style.minHeight) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => element.style.removeProperty("min-height"));
      }
      height = now;
    });
    observer.observe(thread);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another conversation is the trigger.
  useLayoutEffect(() => {
    foot.current?.style.removeProperty("min-height");
  }, [ownerKey]);

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
  // Reveal a chosen conversation or loaded history in place. Translating the whole thread
  // enlarges scrollable overflow, making scroll-follow compensate and then snap back.
  // Messages arriving in an already visible thread still ease in row by row.
  const revealed = useRef({ reveal, loading });
  useLayoutEffect(() => {
    const was = revealed.current;
    revealed.current = { reveal, loading };
    if (history.current && (was.reveal !== reveal || (was.loading && !loading)))
      fadeIn(history.current);
  }, [reveal, loading]);
  // Scrolled back only as far as the foot, the reader has nothing newer to jump to, unless the
  // thread's page ends before the thread does.
  const jumpShown = !follow.pinned && (unread.length > 0 || !endSeen || page.hasNewer);

  const queue = useMemo(
    () => (api && sessionId && !ended ? { api, sessionId } : undefined),
    [api, sessionId, ended],
  );
  // A chat: the bubble a finger holds, whose menu is open, the text being selected and the steps
  // unfolded.
  const [bubble, setBubble] = useState<HeldBubble | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSteps = useCallback((key: string, open: boolean) => {
    setOpened((was) => {
      const next = new Set(was);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const chatNow = useRef({ shown, opened, sessionId, ended, names });
  chatNow.current = { shown, opened, sessionId, ended, names };
  const hold = useCallback(
    (message: AgentMessage, from: HTMLElement) => {
      setBubble(
        heldBubble(message, from, chatNow.current, {
          select: setSelecting,
          toggleSteps,
          again: (text) => suggestNow.current(text),
          replay: (id, atMs) => replayTaskNow.current?.(id, atMs),
          canReplay: !!replayNow.current,
        }),
      );
    },
    [toggleSteps],
  );
  const chatMode = useMemo(
    () => (chat ? { hold, opened, toggle: toggleSteps } : undefined),
    [chat, hold, opened, toggleSteps],
  );
  const thread: ThreadContext = {
    queue,
    moves,
    takeBack,
    announce,
    words,
    downloads,
    results: results.length,
    offers,
    ended,
    pendingAsk,
    ask,
    latestWork: latestWork?.key,
    latestDot: items.findLast((item) => item.kind === "dot")?.key,
    dotLook,
    live,
    onReplay: onReplay && replay,
    replayTask: onReplayTask && replayTask,
    names,
    chat: chatMode,
  };
  const empty = !shown.length && !queued.length;
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
  const suggestNow = useRef(suggest);
  suggestNow.current = suggest;
  // How far the jump button reaches up into the thread from its bottom edge, shown or not.
  const jumpReach = () => {
    const view = scroller.current,
      column = body.current,
      button = jump.current;
    if (!view || !column || !button) return 0;
    return (
      view.getBoundingClientRect().bottom - column.getBoundingClientRect().top - button.offsetTop
    );
  };
  const content = (
    <div className="thread-body" ref={body} data-covered={covered || undefined}>
      <ScrollArea
        ref={attach}
        className="thread-scroll"
        inert={covered}
        fade="both"
        onClickCapture={(event) => {
          const target =
            event.target instanceof Element
              ? event.target.closest<HTMLButtonElement>(
                  ".thread-work-steps > .ui-disclosure-trigger, .thread-work button.activity-row-head, .deliverable button.ui-file-main",
                )
              : null;
          if (!target) return;
          // A step inside a run's list is seen through the list, which keeps its own place.
          const list = target.closest<HTMLElement>(".thread-work-scroll");
          const opening = target.getAttribute("aria-expanded") === "false";
          follow.anchorTo(list ?? target, list || opening ? undefined : REVEAL_MARGIN);
          // What the reader unfolds comes into view down to its end, clear of the jump button that
          // leaving the end brings, its head kept in view.
          const unfolding = target.closest<HTMLElement>(
            ".activity-row, .thread-work-steps, .deliverable",
          );
          if (unfolding && opening)
            follow.show(
              unfolding,
              REVEAL_MARGIN,
              Math.max(REVEAL_MARGIN, jumpReach() + REVEAL_MARGIN / 2),
              list,
            );
        }}
        onScroll={() => {
          seeEnd();
          if (dockHost.parentElement === end.current) footShown();
          if (!visible) return;
          if (!follow.onScroll()) {
            page.freeze();
            readingBack();
          }
        }}
        {...follow.gestures(reading)}
      >
        <div className="thread-content">
          <section
            className="thread"
            ref={history}
            aria-label={t`Conversation history`}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users focus the history to scroll it.
            tabIndex={0}
          >
            {(earlierInReplay || truncated) && !page.hasOlder && !olderTasks && !loading && (
              <p className="thread-note thread-start">
                {earlierInReplay
                  ? t`Earlier messages are in Replay.`
                  : t`Earlier messages are kept in the task log.`}
              </p>
            )}
            {(page.hasOlder || olderTasks) && !loading && (
              <div className="thread-older" ref={edges.older}>
                {earlier?.reading && <Spinner size={16} label={t`Loading earlier messages`} />}
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
                <h3>{t`What should we do?`}</h3>
                <p>
                  {computerReady
                    ? t`dot works on its own computer. Watch, step in or stop it at any time.`
                    : computerUpdating
                      ? t`Your computer is updating. Ask dot once it's back, in about a minute.`
                      : t`Turn on your computer, then ask dot to do something.`}
                </p>
                <div className="thread-suggestions">
                  {suggestions.map((text) => (
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
                  fresh={settled && index > firstKnown && !known.current.keys.has(row.item.key)}
                  thread={thread}
                />
              ))
            )}
            {page.hasNewer && (
              <p className="thread-note thread-newer" ref={edges.newer}>
                {t`Loading later…`}
              </p>
            )}
            {!loading &&
              queued.map((item, index) => (
                <Row
                  key={item.key}
                  row={{
                    item,
                    groupStart: index === 0 && rows.at(-1)?.item.speaker !== item.speaker,
                    separator: null,
                  }}
                  fresh={false}
                  thread={thread}
                  waiting
                />
              ))}
            {moves.problem && (
              <p className="thread-note" role="alert">
                {moves.problem}
              </p>
            )}
            <div className="thread-outbox" ref={setOutboxSlot} />
            <div className="thread-recovery-slot" ref={recoverySlot}>
              {recovery}
            </div>
          </section>
          {threadFoot}
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
          round
          variant="quiet"
          icon="arrow-down"
          aria-label={
            choiceWaits ? undefined : unread.length ? unreadLabel(unread) : t`Jump to latest`
          }
          onClick={() => {
            page.latest();
            follow.jump();
            reachChoice.current?.();
          }}
        >
          <span className="thread-jump-label">
            {choiceWaits
              ? t`Check your last message`
              : unread.length
                ? unreadLabel(unread)
                : t`Latest`}
          </span>
        </Button>
      </span>
      <div className="thread-foot" ref={foot} />
      {createPortal(
        <Outbox.Provider value={outbox}>
          {!tools && decisions}
          <div className="thread-toolbar">
            {!controls && lead}
            <div className="thread-composer" hidden={!!controls}>
              {composer}
            </div>
            {controls}
            {trail}
          </div>
        </Outbox.Provider>,
        dockHost,
      )}
      {chat && (
        <>
          <BubbleMenu held={bubble} onClose={() => setBubble(null)} />
          <Sheet
            open={selecting !== null}
            onClose={() => setSelecting(null)}
            title={t`Select text`}
            side="bottom"
            doneLabel={t`Done`}
          >
            <div className="bubble-select">
              <SafeMarkdown text={selecting ?? ""} streaming={false} announce={announce} />
            </div>
          </Sheet>
        </>
      )}
    </div>
  );
  return (
    <StepPreviewScope api={api} sessionId={sessionId} results={results} scale={scale}>
      {content}
    </StepPreviewScope>
  );
}
