// biome-ignore-all lint/a11y/useFocusableInteractive: rows are reached through aria-activedescendant on the search field, which keeps focus.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: the search field takes the keys for every row.
// biome-ignore-all lint/a11y/useSemanticElements: a listbox's groups are ARIA groups; a fieldset cannot sit in one.
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ConversationRow,
  conversationRows,
  groupConversations,
  type LiveFacts,
  matchesConversation,
  STATUS_LABEL,
  useRecentConversations,
  whenLabel,
} from "../agent/conversation-list.ts";
import { DotLoader } from "../dot/DotLoader.tsx";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { useTaskSearch } from "../replay/search-api.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { Popover, triggerProps } from "../ui/Popover.tsx";
import { TextField } from "../ui/TextField.tsx";
import { useVirtualRows } from "../ui/useVirtualRows.ts";
import "./rails.css";

export interface ConversationListProps {
  api: ApiClient;
  // The list is on show: it reads the conversations again each time it opens.
  open: boolean;
  // The current conversation's latest task.
  current: string | null;
  facts: LiveFacts;
  // Why another conversation can't be taken up now.
  reason?: string;
  onPick(sessionId: string, sessions?: readonly string[]): void;
  onReplay(): void;
  onDeleted?(sessions: readonly string[]): void;
}

// The recent conversations by day, a search over them and the way into Replay for the rest. The
// search field keeps the focus while the arrows move through the rows, as a picker's does.
export function ConversationList({
  api,
  open,
  current,
  facts,
  reason,
  onPick,
  onReplay,
  onDeleted,
}: ConversationListProps) {
  const listId = useId();
  const actionAnchor = useRef<HTMLButtonElement | null>(null);
  const [action, setAction] = useState<ConversationRow | null>(null);
  const [deleting, setDeleting] = useState<ConversationRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/conversations/${deleting.entry.sessionId}`);
      onDeleted?.(deleting.entry.sessions);
      setDeleting(null);
      recent.retry();
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? "Stop this conversation's task before deleting it."
          : "The conversation couldn't be deleted. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const recent = useRecentConversations(api, open);
  const [query, setQuery] = useState("");
  const matches = useTaskSearch(api, query);
  const [now] = useState(() => new Date());
  const found = useMemo(() => new Set(matches.tasks.keys()), [matches.tasks]);
  const rows = useMemo(
    () =>
      conversationRows(recent.entries, facts).filter((row) =>
        matchesConversation(row.entry, query, found),
      ),
    [recent.entries, facts, query, found],
  );
  const groups = useMemo(() => groupConversations(rows, now), [rows, now]);
  const ordered = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const [active, setActive] = useState<string | null>(null);
  const activeRow =
    ordered.find((row) => row.entry.sessionId === active) ??
    ordered.find((row) => row.entry.sessionId === current) ??
    ordered[0];
  const optionId = (row: ConversationRow) => `${listId}-${row.entry.sessionId}`;
  const list = useRef<HTMLDivElement>(null);
  const flat = useMemo(
    () =>
      groups.flatMap((group) => [
        { key: group.label, label: group.label, row: null as ConversationRow | null },
        ...group.rows.map((row) => ({ key: row.entry.sessionId, label: group.label, row })),
      ]),
    [groups],
  );
  const windowed = useVirtualRows(
    list,
    useMemo(() => flat.map((item) => item.key), [flat]),
    (index) => (flat[index]?.row ? 52 : 36),
  );
  const activeKey = activeRow?.entry.sessionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active row is the trigger.
  useEffect(() => {
    list.current
      ?.querySelector("[data-active]")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey]);
  const pick = (row: ConversationRow) => {
    if (reason && row.entry.sessionId !== current) return;
    onPick(row.entry.sessionId, row.entry.sessions);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const at = activeRow ? ordered.indexOf(activeRow) : -1;
    const to =
      event.key === "ArrowDown"
        ? at + 1
        : event.key === "ArrowUp"
          ? at - 1
          : event.key === "PageDown"
            ? at + 8
            : event.key === "PageUp"
              ? at - 8
              : undefined;
    if (to !== undefined) {
      event.preventDefault();
      const next = ordered[Math.max(0, Math.min(ordered.length - 1, to))];
      if (next) {
        windowed.scrollTo(flat.findIndex((item) => item.key === next.entry.sessionId));
        setActive(next.entry.sessionId);
      }
    } else if (event.key === "Enter" && activeRow) {
      event.preventDefault();
      pick(activeRow);
    }
  };

  let body: ReactNode;
  if (recent.loading)
    body = <DotLoader className="conversations-loading" label="Loading your conversations" />;
  else if (recent.failed)
    body = (
      <EmptyState
        title="Conversations couldn't load"
        icon="circle-alert"
        actions={
          <Button size="sm" onClick={recent.retry}>
            Try again
          </Button>
        }
      />
    );
  else if (recent.entries.length === 0)
    body = (
      <EmptyState title="No conversations yet" icon="message-circle">
        Each conversation with dot is kept here.
      </EmptyState>
    );
  else if (ordered.length === 0)
    body = matches.pending ? (
      <DotLoader className="conversations-loading" label="Searching conversations" />
    ) : (
      <EmptyState layout="start" icon="search" title={`No conversations match “${query.trim()}”`} />
    );
  else
    body = (
      <div
        ref={list}
        id={listId}
        role="grid"
        aria-label="Recent conversations"
        aria-rowcount={ordered.length}
        className="conversations-list"
      >
        <div aria-hidden="true" style={{ height: windowed.before }} />
        {windowed.indexes.map((index) => {
          const item = flat[index];
          if (!item) return null;
          const row = item.row;
          if (!row)
            return (
              <div
                key={item.key}
                ref={windowed.measure}
                data-index={index}
                role="presentation"
                className="conversations-day"
              >
                {item.label}
              </div>
            );
          const id = row.entry.sessionId;
          const isCurrent = id === current;
          return (
            <div
              key={id}
              ref={windowed.measure}
              data-index={index}
              aria-rowindex={ordered.indexOf(row) + 1}
              id={optionId(row)}
              role="row"
              aria-selected={row === activeRow}
              aria-current={isCurrent || undefined}
              aria-disabled={(!!reason && !isCurrent) || undefined}
              className="conversations-row"
              data-active={row === activeRow || undefined}
              data-current={isCurrent || undefined}
              onPointerMove={() => {
                if (id !== activeKey) setActive(id);
              }}
            >
              <div role="gridcell" className="conversations-main">
                <Button
                  variant="quiet"
                  className="conversations-pick"
                  disabledReason={!isCurrent ? reason : undefined}
                  onClick={() => pick(row)}
                >
                  <span
                    className="conversations-status"
                    data-status={row.status}
                    role="img"
                    aria-label={STATUS_LABEL[row.status]}
                  />
                  <span className="conversations-title">{row.title}</span>
                  <time className="conversations-when num" dateTime={row.entry.startedAt}>
                    {whenLabel(row.entry.startedAt, now)}
                  </time>
                </Button>
              </div>
              <div role="gridcell">
                <IconButton
                  icon="more-horizontal"
                  size={28}
                  label={`Actions for ${row.title}`}
                  {...triggerProps("menu", action?.entry.sessionId === id)}
                  onClick={(event) => {
                    actionAnchor.current = event.currentTarget;
                    setAction(row);
                  }}
                />
              </div>
            </div>
          );
        })}
        <div aria-hidden="true" style={{ height: windowed.after }} />
      </div>
    );

  return (
    <div className="conversations">
      <TextField
        size="sm"
        className="conversations-search"
        prefix={<Icon name="search" />}
        role="combobox"
        aria-label="Search conversations"
        aria-expanded={ordered.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-haspopup="grid"
        aria-activedescendant={activeRow ? optionId(activeRow) : undefined}
        placeholder="Search conversations"
        enterKeyHint="go"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(null);
        }}
        onKeyDown={onKeyDown}
      />
      {reason && <p className="conversations-note">{reason}</p>}
      <div className="conversations-body" aria-busy={recent.loading || matches.pending}>
        {body}
      </div>
      <Menu
        open={action !== null}
        onClose={() => setAction(null)}
        anchor={actionAnchor}
        label="Conversation actions"
        align="end"
      >
        <MenuItem
          icon="message-circle"
          disabledReason={reason && action?.entry.sessionId !== current ? reason : undefined}
          onSelect={() => {
            if (action) pick(action);
          }}
        >
          Open conversation
        </MenuItem>
        <MenuItem
          icon="trash"
          disabledReason={
            action?.entry.sessions.includes(facts.live ?? "")
              ? "Stop this task before deleting its conversation."
              : undefined
          }
          onSelect={() => {
            setError(null);
            setDeleting(action);
          }}
        >
          Delete conversation
        </MenuItem>
      </Menu>
      <Dialog
        open={deleting !== null}
        onClose={() => {
          if (!busy) setDeleting(null);
        }}
        anchor={actionAnchor}
        title="Delete this conversation?"
        description={
          error ? (
            <span role="alert">{error}</span>
          ) : (
            "Its messages, recordings and screenshots will be removed. This can't be undone."
          )
        }
      >
        <Button
          variant="quiet"
          disabledReason={busy ? "Deleting…" : undefined}
          onClick={() => setDeleting(null)}
        >
          Cancel
        </Button>
        <Button variant="destructive" busy={busy} onClick={() => void remove()}>
          Delete
        </Button>
      </Dialog>
      <div className="conversations-foot" data-loading={recent.loading || undefined}>
        <Button variant="quiet" size="sm" icon="history" onClick={onReplay}>
          See all in Replay
        </Button>
      </div>
    </div>
  );
}

// The rail header's way to the recent conversations: a popover from the button.
export function ConversationsButton(props: Omit<ConversationListProps, "open">) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={button}
        icon="message-circle"
        size={32}
        label="Conversations"
        {...triggerProps("dialog", open)}
        onClick={() => setOpen((was) => !was)}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        side="bottom"
        align="end"
        label="Conversations"
        size="lg"
      >
        <ConversationList
          {...props}
          open={open}
          onPick={(id, sessions) => {
            setOpen(false);
            props.onPick(id, sessions);
          }}
          onReplay={() => {
            setOpen(false);
            props.onReplay();
          }}
        />
      </Popover>
    </>
  );
}
