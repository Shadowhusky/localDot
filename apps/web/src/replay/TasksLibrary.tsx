import { type SessionCard, SessionIndexPage } from "@localdot/protocol";
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
import { type ApiClient, ApiError } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { TextField } from "../ui/TextField.tsx";
import { ReplayImage } from "./ReplayImage.tsx";
import { byDay, matchesSearch, taskMeta, taskTitle, verdictGlyph } from "./replay-view.ts";

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

export function TasksSearch({ value, onChange }: { value: string; onChange(value: string): void }) {
  return (
    <TextField
      className="replay-search"
      prefix={<Icon name="search" />}
      aria-label="Search tasks"
      placeholder="Search tasks"
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

function rowLinks(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(".replay-task-open")];
}

export function TaskList({
  api,
  index,
  search,
  selectedId,
  onSelect,
  onDeleted,
  continueTask,
}: {
  api: ApiClient;
  index: TaskIndex;
  search: string;
  selectedId: string | null;
  onSelect(id: string): void;
  onDeleted(id: string): void;
  continueTask?: ContinueTask;
}) {
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const [menuFor, setMenuFor] = useState<SessionCard | null>(null);
  const [deleting, setDeleting] = useState<SessionCard | null>(null);
  const now = useMemo(() => new Date(), []);
  const searching = search.trim() !== "";
  const shown = searching ? index.cards.filter((card) => matchesSearch(card, search)) : index.cards;
  const { more, loading, failed, loadMore } = index;

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

  const ask = (card: SessionCard, from: HTMLElement | null) => {
    anchor.current = from;
    setDeleting(card);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    const rows = list.current ? rowLinks(list.current) : [];
    const at = rows.indexOf(event.target as HTMLElement);
    if (at < 0) return;
    const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[event.key];
    if (go !== undefined) {
      event.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, go))]?.focus();
    } else if (event.key === "Backspace" || event.key === "Delete") {
      const card = shown.find((item) => item.id === rows[at]?.dataset.task);
      if (!card) return;
      event.preventDefault();
      ask(
        card,
        rows[at]?.parentElement?.querySelector<HTMLElement>(".replay-task-more button") ?? null,
      );
    }
  };

  let body: ReactNode;
  if (index.failed && index.cards.length === 0)
    body = (
      <EmptyState
        title="Tasks couldn't load"
        icon="circle-alert"
        actions={
          <Button size="sm" onClick={index.retry}>
            Try again
          </Button>
        }
      />
    );
  else if (loading && index.cards.length === 0) body = <TaskSkeletons />;
  else if (index.cards.length === 0)
    body = (
      <EmptyState title="No tasks yet" icon="monitor">
        Each task dot runs is recorded here, to watch again.
      </EmptyState>
    );
  else if (shown.length === 0 && !(more || loading))
    body = <EmptyState layout="start" icon="search" title={`No tasks match “${search.trim()}”`} />;
  else
    body = byDay(shown, now).map(({ day, cards }) => (
      <Day key={day} day={day}>
        {cards.map((card) => (
          <TaskRow
            key={card.id}
            api={api}
            card={card}
            selected={card.id === selectedId}
            menuOpen={menuFor?.id === card.id}
            onOpen={() => onSelect(card.id)}
            onKeyDown={onKeyDown}
            onMore={(trigger) => {
              anchor.current = trigger;
              setMenuFor(card);
            }}
          />
        ))}
      </Day>
    ));

  return (
    <div ref={list} className="replay-tasks">
      {body}
      {index.failed && index.cards.length > 0 && (
        <p className="replay-tasks-note" role="alert">
          More tasks couldn't load.{" "}
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
      <Menu
        open={menuFor !== null}
        onClose={() => setMenuFor(null)}
        anchor={anchor}
        align="end"
        label={menuFor ? `Actions for ${taskTitle(menuFor)}` : "Task actions"}
      >
        {continueTask && menuFor && continuable(menuFor, continueTask) && (
          <MenuItem
            disabledReason={continueTask.reason}
            onSelect={() => continueTask.run(menuFor.id)}
          >
            Continue conversation
          </MenuItem>
        )}
        <MenuItem
          kbd={["Backspace"]}
          onSelect={() => {
            if (menuFor) ask(menuFor, anchor.current);
          }}
        >
          Delete recording…
        </MenuItem>
      </Menu>
      <DeleteTask
        api={api}
        card={deleting}
        anchor={anchor}
        onClose={() => setDeleting(null)}
        onDeleted={(card) => {
          const rows = list.current ? rowLinks(list.current) : [];
          const at = rows.findIndex((row) => row.dataset.task === card.id);
          anchor.current = rows[at + 1] ?? rows[at - 1] ?? null;
          setDeleting(null);
          index.forget(card.id);
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

function TaskRow({
  api,
  card,
  selected,
  menuOpen,
  onOpen,
  onKeyDown,
  onMore,
}: {
  api: ApiClient;
  card: SessionCard;
  selected: boolean;
  menuOpen: boolean;
  onOpen(): void;
  onKeyDown(event: KeyboardEvent<HTMLAnchorElement>): void;
  onMore(trigger: HTMLElement): void;
}) {
  const title = taskTitle(card);
  const verdict = verdictGlyph(card.verdict);
  return (
    <li className="replay-task" data-selected={selected ? "" : undefined}>
      <a
        className="replay-task-open"
        href={`?replay=${card.id}`}
        data-task={card.id}
        aria-current={selected ? "page" : undefined}
        draggable={false}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpen();
        }}
      >
        <span className="replay-task-cover" aria-hidden="true">
          <ReplayImage api={api} sessionId={card.id} frameId={card.coverFrameId} />
        </span>
        <span className="replay-task-text">
          <span className="replay-task-title">{title}</span>
          <span className="replay-task-meta num">{taskMeta(card)}</span>
        </span>
        <StatusGlyph className="replay-task-verdict" state={verdict.state} label={verdict.label} />
      </a>
      <span className="replay-task-more" data-open={menuOpen ? "" : undefined}>
        <IconButton
          size={24}
          icon="more-horizontal"
          label={`More for ${title}`}
          {...triggerProps("menu", menuOpen)}
          onClick={(event) => onMore(event.currentTarget)}
        />
      </span>
    </li>
  );
}

function TaskSkeletons({ count = 3 }: { count?: number }) {
  return (
    <div className="replay-skeletons" aria-hidden="true">
      {Array.from({ length: count }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have nothing else to key on.
        <div key={row} className="replay-skeleton-row">
          <Skeleton loading shape="block" width="72px" height="45px" />
          <span className="replay-task-text">
            <Skeleton loading width="16ch" />
            <Skeleton loading width="9ch" />
          </span>
        </div>
      ))}
    </div>
  );
}

function DeleteTask({
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
  const last = useRef(card);
  if (card) last.current = card;
  const shown = last.current;
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
      title="Delete this task's recording?"
      description={
        error ? (
          <span role="alert">{error}</span>
        ) : (
          `“${shown ? taskTitle(shown) : ""}” and its video, screenshots and steps are removed from this Mac. You can't undo this.`
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
      <Button busy={busy} onClick={() => void remove()}>
        Delete
      </Button>
    </Dialog>
  );
}
