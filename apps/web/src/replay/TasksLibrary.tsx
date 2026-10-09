import { type SearchHit, type SessionCard, SessionIndexPage } from "@localdot/protocol";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { DotLoader } from "../dot/DotLoader.tsx";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { dayLabel } from "../settings/memory/memory-copy.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { ListRow } from "../ui/ListRow.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { TextField } from "../ui/TextField.tsx";
import { Highlight } from "./Highlight.tsx";
import { ReplayImage } from "./ReplayImage.tsx";
import {
  byDay,
  inFilter,
  type LibraryFilter,
  matchesSearch,
  rowMeta,
  taskTitle,
  timeLabel,
  verdictGlyph,
} from "./replay-view.ts";
import type { TaskMatches } from "./search-api.ts";

// A deleted row folds away over this long before the list lets it go.
const FOLD_MS = 470;

export interface ContinueTask {
  // The current conversation's latest task: the next message already continues it.
  current: string | null;
  // Why no conversation can be continued now.
  reason?: string;
  run(sessionId: string): void;
}

export interface TaskIndex {
  cards: SessionCard[];
  more: boolean;
  loading: boolean;
  failed: boolean;
  loadMore(): void;
  retry(): void;
  forget(id: string): void;
}

// The recorded tasks, newest first, a page at a time.
export function useTaskIndex(api: ApiClient): TaskIndex {
  const [cards, setCards] = useState<SessionCard[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const loadMore = useRef<() => void>(() => {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new revision reads the list again from its first page.
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    let cursor: string | null = null;
    const load = async (initial: boolean) => {
      if (busy || (!initial && cursor === null)) return;
      busy = true;
      setLoading(true);
      setFailed(false);
      try {
        const page = SessionIndexPage.parse(
          await api.get(
            `/api/session-index${initial ? "" : `?before=${encodeURIComponent(cursor ?? "")}`}`,
            { signal: controller.signal },
          ),
        );
        if (controller.signal.aborted) return;
        cursor = page.next;
        setCards((previous) =>
          initial
            ? page.sessions
            : [
                ...previous,
                ...page.sessions.filter((card) => !previous.some((p) => p.id === card.id)),
              ],
        );
        setMore(page.next !== null);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        busy = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    loadMore.current = () => void load(false);
    void load(true);
    return () => controller.abort();
  }, [api, revision]);
  return {
    cards,
    more,
    loading,
    failed,
    loadMore: useCallback(() => loadMore.current(), []),
    retry: useCallback(() => setRevision((value) => value + 1), []),
    forget: useCallback((id: string) => {
      setCards((previous) => previous.filter((card) => card.id !== id));
      setRevision((value) => value + 1);
    }, []),
  };
}

export function TasksSearch({
  value,
  onChange,
  size = "md",
  filled = false,
}: {
  value: string;
  onChange(value: string): void;
  size?: "sm" | "md";
  filled?: boolean;
}) {
  return (
    <TextField
      className="replay-search"
      size={size}
      filled={filled}
      prefix={<Icon name="search" />}
      aria-label="Search recordings"
      placeholder="Search recordings"
      enterKeyHint="search"
      autoComplete="off"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && value) {
          event.preventDefault();
          onChange("");
        }
      }}
    />
  );
}

// The recordings a search and a filter leave, in the index's order: a title that matches, or
// words said in the task that the search index found.
export function shownCards(
  cards: readonly SessionCard[],
  search: string,
  filter: LibraryFilter = "all",
  matches?: TaskMatches,
): SessionCard[] {
  return cards.filter(
    (card) =>
      inFilter(card, filter) &&
      (search.trim() === "" || matchesSearch(card, search) || !!matches?.tasks.has(card.id)),
  );
}

const MATCH_KIND: Record<SearchHit["kind"], string> = {
  title: "Title",
  user: "You wrote",
  assistant: "dot replied",
  summary: "Result",
  step: "Step",
  file: "File",
  note: "Daily note",
};

function rowButtons(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(".ui-list-row-select")];
}

export function TaskList({
  api,
  index,
  search,
  filter = "all",
  selectedId,
  onSelect,
  onDeleted,
  continueTask,
  matches,
  variant = "library",
}: {
  api: ApiClient;
  index: TaskIndex;
  search: string;
  filter?: LibraryFilter;
  matches?: TaskMatches;
  selectedId: string | null;
  // A row was chosen: the library shows it beside the list, a phone or the rail opens it.
  onSelect(id: string): void;
  onDeleted(id: string): void;
  continueTask?: ContinueTask;
  // The library's wide rows; a phone's, with the length in the meta line, Continue always shown and
  // a swipe to delete; or the player's rail, where a row only opens its recording.
  variant?: "library" | "phone" | "rail";
}) {
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const [deleting, setDeleting] = useState<SessionCard | null>(null);
  const [folding, setFolding] = useState<ReadonlySet<string>>(new Set());
  const now = useMemo(() => new Date(), []);
  const searching = search.trim() !== "" || filter !== "all";
  const shown = shownCards(index.cards, search, filter, matches);
  const notes = search.trim() && filter === "all" ? (matches?.notes ?? []) : [];
  const { more, loading, failed, loadMore, forget } = index;

  // A search looks through every task, so it reads the pages a scroll has not reached yet. A page
  // that failed waits for Try again.
  useEffect(() => {
    if (searching && more && !loading && !failed) loadMore();
  }, [searching, more, loading, failed, loadMore]);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !more || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [more, loadMore]);

  useEffect(() => {
    if (folding.size === 0) return;
    const timer = setTimeout(() => {
      for (const id of folding) forget(id);
      setFolding(new Set());
    }, FOLD_MS);
    return () => clearTimeout(timer);
  }, [folding, forget]);

  const ask = (card: SessionCard, from: HTMLElement | null) => {
    anchor.current = from;
    setDeleting(card);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = list.current ? rowButtons(list.current) : [];
    const at = rows.indexOf(event.target as HTMLElement);
    if (at < 0) return;
    const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[event.key];
    if (go !== undefined) {
      event.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, go))]?.focus();
    } else if (event.key === "Backspace" || event.key === "Delete") {
      const card = shown.find((item) => item.id === rows[at]?.closest("li")?.dataset.task);
      if (!card) return;
      event.preventDefault();
      ask(card, rows[at] ?? null);
    }
  };

  let body: ReactNode;
  if (index.failed && index.cards.length === 0)
    body = (
      <EmptyState
        title="Recordings couldn't load"
        icon="circle-alert"
        actions={
          <Button size="sm" onClick={index.retry}>
            Try again
          </Button>
        }
      />
    );
  else if (loading && index.cards.length === 0)
    body = <DotLoader className="replay-loading" label="Loading your recordings" />;
  else if (index.cards.length === 0)
    body = (
      <EmptyState title="No recordings yet" icon="history">
        Each task dot runs is recorded here, to watch again.
      </EmptyState>
    );
  else if (shown.length === 0 && notes.length === 0 && !(more || loading || matches?.pending))
    body = (
      <EmptyState
        layout="start"
        icon="search"
        title={search.trim() ? `No recordings match “${search.trim()}”` : "No recordings here"}
      />
    );
  else
    body = byDay(shown, now).map(({ day, cards }) => (
      <Day key={day} day={day}>
        {cards.map((card) => (
          <TaskRow
            key={card.id}
            api={api}
            card={card}
            variant={variant}
            selected={variant !== "phone" && card.id === selectedId}
            folding={folding.has(card.id)}
            continueTask={variant === "rail" ? undefined : continueTask}
            match={matchesSearch(card, search) ? undefined : matches?.tasks.get(card.id)}
            onSelect={() => onSelect(card.id)}
            onDelete={(trigger) => ask(card, trigger)}
          />
        ))}
      </Day>
    ));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the rows' own buttons take the keys; the list only moves focus between them.
    <div ref={list} className="replay-tasks" data-variant={variant} onKeyDown={onKeyDown}>
      {body}
      {notes.length > 0 && <NoteMatches notes={notes} now={now} />}
      {index.failed && index.cards.length > 0 && (
        <p className="replay-tasks-note" role="alert">
          More recordings couldn't load.{" "}
          <Button size="sm" variant="quiet" onClick={index.loadMore}>
            Try again
          </Button>
        </p>
      )}
      {more && index.cards.length > 0 && (
        <div ref={sentinel} className="replay-tasks-more">
          <TaskSkeletons count={1} />
        </div>
      )}
      <DeleteTask
        api={api}
        card={deleting}
        anchor={anchor}
        onClose={() => setDeleting(null)}
        onDeleted={(card) => {
          const rows = list.current ? rowButtons(list.current) : [];
          const at = rows.findIndex((row) => row.closest("li")?.dataset.task === card.id);
          anchor.current = rows[at + 1] ?? rows[at - 1] ?? null;
          setDeleting(null);
          setFolding((was) => new Set([...was, card.id]));
          onDeleted(card.id);
        }}
      />
    </div>
  );
}

// A task that has ended can take its conversation up again, unless it is already where it goes on.
export function continuable(card: Pick<SessionCard, "id" | "verdict">, task: ContinueTask) {
  return card.verdict !== "live" && card.id !== task.current;
}

function Day({ day, children }: { day: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="replay-day" aria-labelledby={id}>
      <h3 id={id} className="replay-day-title">
        {day}
      </h3>
      <ul className="replay-day-list">{children}</ul>
    </section>
  );
}

// Daily notes that match: dot's own notes, from tasks that may since have been deleted.
function NoteMatches({ notes, now }: { notes: readonly SearchHit[]; now: Date }) {
  return (
    <Day day="Daily notes">
      {notes.map((note) => (
        <li key={`${note.at}:${note.snippet}`} className="replay-note">
          <span className="replay-note-text">
            <Highlight text={note.snippet} />
          </span>
          <span className="replay-note-day num">{dayLabel(note.at, now)}</span>
        </li>
      ))}
    </Day>
  );
}

function TaskRow({
  api,
  card,
  variant,
  selected,
  folding,
  continueTask,
  match,
  onSelect,
  onDelete,
}: {
  api: ApiClient;
  card: SessionCard;
  variant: "library" | "phone" | "rail";
  selected: boolean;
  folding: boolean;
  continueTask?: ContinueTask;
  // What the task said that a search found, when its title alone did not match.
  match?: SearchHit;
  onSelect(): void;
  onDelete(trigger: HTMLElement): void;
}) {
  const title = taskTitle(card);
  const verdict = verdictGlyph(card.verdict);
  const phone = variant === "phone";
  const wide = variant === "library";
  return (
    <li className="replay-task" data-task={card.id} data-folding={folding ? "" : undefined}>
      <div className="replay-task-fold">
        <ListRow
          title={title}
          compact={variant === "rail"}
          selected={selected}
          onSelect={onSelect}
          thumbnail={<ReplayImage api={api} sessionId={card.id} frameId={card.coverFrameId} />}
          meta={
            <>
              <StatusGlyph state={verdict.state} label={verdict.label} />
              {match ? (
                <span className="replay-match">
                  {/* A narrow row leads with the matched word itself. */}
                  {!phone && `${MATCH_KIND[match.kind]} · `}
                  <Highlight text={match.snippet} before={phone ? 0 : 8} />
                </span>
              ) : (
                <span className="num">{rowMeta(card, !wide)}</span>
              )}
            </>
          }
          trailing={wide && card.durationMs !== null ? timeLabel(card.durationMs) : undefined}
          actions={
            variant !== "rail" && (
              <>
                {continueTask && (
                  <Button
                    size="sm"
                    icon={phone ? undefined : "continue"}
                    disabledReason={
                      continuable(card, continueTask) ? continueTask.reason : undefined
                    }
                    onClick={() => continueTask.run(card.id)}
                  >
                    Continue
                  </Button>
                )}
                {wide && (
                  <IconButton
                    size={28}
                    icon="trash"
                    label={`Delete ${title}`}
                    onClick={(event) => onDelete(event.currentTarget)}
                  />
                )}
              </>
            )
          }
          swipe={
            phone
              ? { label: "Delete", accessibleLabel: `Delete ${title}`, onAction: onDelete }
              : undefined
          }
        />
      </div>
    </li>
  );
}

export function TaskSkeletons({ count = 3 }: { count?: number }) {
  return (
    <div className="replay-skeletons" aria-hidden="true">
      {Array.from({ length: count }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have nothing else to key on.
        <div key={row} className="replay-skeleton-row">
          <Skeleton loading shape="block" width="96px" height="60px" />
          <span className="replay-skeleton-text">
            <Skeleton loading width="24ch" />
            <Skeleton loading width="14ch" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function DeleteTask({
  api,
  card,
  anchor,
  onClose,
  onDeleted,
}: {
  api: ApiClient;
  card: SessionCard | null;
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  onDeleted(card: SessionCard): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opened = card?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a newly opened card starts clean.
  useEffect(() => {
    setError(null);
    setBusy(false);
  }, [opened]);
  const remove = async () => {
    if (!card || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/sessions/${card.id}`);
      onDeleted(card);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? "This task is still running. Stop it before deleting its recording."
          : "The recording couldn't be deleted. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={card !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      anchor={anchor}
      title="Delete this recording?"
      description={
        error ? (
          <span role="alert">{error}</span>
        ) : (
          "Its video, screenshots and steps are removed from this Mac. You can't undo this."
        )
      }
    >
      <Button
        variant="quiet"
        disabledReason={busy ? "Deleting the recording…" : undefined}
        onClick={onClose}
      >
        Cancel
      </Button>
      <Button variant="destructive" busy={busy} onClick={() => void remove()}>
        Delete
      </Button>
    </Dialog>
  );
}
