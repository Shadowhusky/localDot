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
import type { ApiClient } from "../lib/api.ts";
import { useTaskSearch } from "../replay/search-api.ts";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Popover, triggerProps } from "../ui/Popover.tsx";
import { TextField } from "../ui/TextField.tsx";
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
  onPick(sessionId: string): void;
  onReplay(): void;
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
}: ConversationListProps) {
  const listId = useId();
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
  const activeKey = activeRow?.entry.sessionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active row is the trigger.
  useEffect(() => {
    list.current
      ?.querySelector("[data-active]")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeKey]);
  const pick = (row: ConversationRow) => {
    if (reason && row.entry.sessionId !== current) return;
    onPick(row.entry.sessionId);
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
      if (next) setActive(next.entry.sessionId);
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
    body = matches.pending ? null : (
      <EmptyState layout="start" icon="search" title={`No conversations match “${query.trim()}”`} />
    );
  else
    body = (
      <div
        ref={list}
        id={listId}
        role="listbox"
        aria-label="Recent conversations"
        className="conversations-list"
      >
        {groups.map((group) => (
          <div
            key={group.label}
            role="group"
            aria-labelledby={`${listId}-${group.label}`}
            className="conversations-group"
          >
            <div id={`${listId}-${group.label}`} role="presentation" className="conversations-day">
              {group.label}
            </div>
            {group.rows.map((row) => {
              const id = row.entry.sessionId;
              const isCurrent = id === current;
              return (
                <div
                  key={id}
                  id={optionId(row)}
                  role="option"
                  aria-selected={row === activeRow}
                  aria-current={isCurrent || undefined}
                  aria-disabled={(!!reason && !isCurrent) || undefined}
                  className="conversations-row"
                  data-active={row === activeRow || undefined}
                  data-current={isCurrent || undefined}
                  onPointerMove={() => {
                    if (id !== activeKey) setActive(id);
                  }}
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
                </div>
              );
            })}
          </div>
        ))}
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
      <div className="conversations-body">{body}</div>
      <div className="conversations-foot">
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
          onPick={(id) => {
            setOpen(false);
            props.onPick(id);
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
