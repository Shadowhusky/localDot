// biome-ignore-all lint/a11y/useFocusableInteractive: rows are reached through aria-activedescendant on the search field, which keeps focus.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: the search field takes the keys for every row.
// biome-ignore-all lint/a11y/useSemanticElements: a listbox's groups are ARIA groups; a fieldset cannot sit in one.

import { CONVERSATION_NAME_CHARS, RenameConversation } from "@localdot/protocol";
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
  type ConversationGroup,
  type ConversationRow,
  type ConversationView,
  conversationRows,
  groupConversations,
  type LiveFacts,
  organizeConversation,
  STATUS_LABEL,
  useRecentConversations,
  whenLabel,
} from "../agent/conversation-list.ts";
import { searchConversations } from "../agent/conversation-search.ts";
import { DotLoader } from "../dot/DotLoader.tsx";
import type { ApiClient } from "../lib/api.ts";
import { Highlight } from "../replay/Highlight.tsx";
import { useTaskSearch } from "../replay/search-api.ts";
import { announce } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { TagMark } from "../ui/ConversationTag.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { MenuItem } from "../ui/Menu.tsx";
import { Popover, triggerProps } from "../ui/Popover.tsx";
import { SessionGlyph } from "../ui/SessionGlyph.tsx";
import { TextField } from "../ui/TextField.tsx";
import { useVirtualRows } from "../ui/useVirtualRows.ts";
import { ConversationMenu } from "./ConversationMenu.tsx";
import { DeleteConversationDialog } from "./DeleteConversationDialog.tsx";
import "../ui/conversations-layout.css";
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

// The recent conversations, those pinned and those under way first and the rest by day, a search
// over them, best first, and the way into Replay for the rest. The search field keeps the focus while the arrows move through
// the rows, as a picker's does.
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
  // The row whose name is being typed in place, and what is typed. An empty name gives the
  // conversation back its automatic one.
  const [renaming, setRenaming] = useState<{ id: string; name: string; was: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  // Enter and the blur that follows the field going save once.
  const editing = useRef(renaming);
  editing.current = renaming;
  const rename = async () => {
    const current = editing.current;
    if (!current) return;
    editing.current = null;
    setRenaming(null);
    const { id, name, was } = current;
    if (name.trim() === was) return;
    const body = RenameConversation.safeParse({ title: name.trim() || null });
    if (!body.success) {
      setRenameError("Use one line of text for the name.");
      return;
    }
    try {
      await api.post(`/api/conversations/${id}/title`, body.data);
      setRenameError(null);
      recent.retry();
    } catch {
      setRenameError("The new name couldn't be saved. Try again.");
    }
  };
  // The archived conversations take the list's place until the user goes back.
  const [view, setView] = useState<ConversationView>("recent");
  if (!open && view !== "recent") setView("recent");
  const recent = useRecentConversations(api, open, view);
  const [query, setQuery] = useState("");
  const matches = useTaskSearch(api, query);
  const [now] = useState(() => new Date());
  const all = useMemo(() => conversationRows(recent.entries, facts), [recent.entries, facts]);
  const found = useMemo(
    () => (query.trim() ? searchConversations(all, query, matches.tasks) : null),
    [all, query, matches.tasks],
  );
  const groups = useMemo(
    (): ConversationGroup[] =>
      found
        ? found.length
          ? [{ label: "Results", rows: found.map((match) => match.row) }]
          : []
        : groupConversations(all, now),
    [found, all, now],
  );
  const marked = useMemo(
    () => new Map(found?.map((match) => [match.row.entry.sessionId, match])),
    [found],
  );
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
  else if (recent.entries.length === 0 && view === "archived")
    body = <EmptyState title="Nothing archived" icon="archive" />;
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
          const match = marked.get(id);
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
                {renaming?.id === id ? (
                  <TextField
                    size="sm"
                    className="conversations-rename"
                    aria-label={`New name for ${row.title}`}
                    placeholder="Automatic name"
                    maxLength={CONVERSATION_NAME_CHARS}
                    autoComplete="off"
                    enterKeyHint="done"
                    autoFocus
                    value={renaming.name}
                    onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
                    onBlur={() => void rename()}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void rename();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                  />
                ) : (
                  <Button
                    variant="quiet"
                    className="conversations-pick"
                    disabledReason={!isCurrent ? reason : undefined}
                    onClick={() => pick(row)}
                  >
                    <span className="conversations-glyph">
                      <SessionGlyph
                        status={row.status}
                        label={STATUS_LABEL[row.status]}
                        className="conversations-status"
                      />
                      <TagMark tag={row.entry.tag} />
                    </span>
                    <span className="conversations-title">
                      {match ? <Highlight text={match.title} /> : row.title}
                    </span>
                    <time className="conversations-when num" dateTime={row.since}>
                      {whenLabel(row.since, now)}
                    </time>
                    {(match?.snippet ?? row.activity) && (
                      <span className="conversations-activity">
                        {match?.snippet ? (
                          <Highlight text={match.snippet} before={32} />
                        ) : (
                          row.activity
                        )}
                      </span>
                    )}
                  </Button>
                )}
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
      {renameError && (
        <p className="conversations-note" role="alert">
          {renameError}
        </p>
      )}
      <div className="conversations-body" aria-busy={recent.loading || matches.pending}>
        {body}
      </div>
      <ConversationMenu
        entry={action?.entry ?? null}
        anchor={actionAnchor}
        onClose={() => setAction(null)}
        align="end"
        running={!!action && (action.active || action.entry.sessions.includes(facts.live ?? ""))}
        onRename={() => {
          if (action)
            setRenaming({ id: action.entry.sessionId, name: action.title, was: action.title });
        }}
        onOrganize={(change) => {
          if (action)
            organizeConversation(api, action.entry.sessionId, change).catch(() =>
              announce("conversation", "That change couldn't be saved. Try again.", "assertive"),
            );
        }}
        onDelete={() => setDeleting(action)}
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
      </ConversationMenu>
      <DeleteConversationDialog
        api={api}
        conversation={deleting?.entry ?? null}
        anchor={actionAnchor}
        onClose={() => setDeleting(null)}
        onDeleted={onDeleted}
      />
      <div className="conversations-foot" data-loading={recent.loading || undefined}>
        {view === "archived" ? (
          <Button variant="quiet" size="sm" icon="chevron-left" onClick={() => setView("recent")}>
            Recent conversations
          </Button>
        ) : (
          <>
            <Button variant="quiet" size="sm" icon="history" onClick={onReplay}>
              See all in Replay
            </Button>
            {recent.archivedCount > 0 && (
              <Button variant="quiet" size="sm" icon="archive" onClick={() => setView("archived")}>
                Archived ({recent.archivedCount})
              </Button>
            )}
          </>
        )}
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
