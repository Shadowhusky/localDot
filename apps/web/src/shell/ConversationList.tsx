// biome-ignore-all lint/a11y/useFocusableInteractive: rows are reached through aria-activedescendant on the search field, which keeps focus.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: the search field takes the keys for every row.
// biome-ignore-all lint/a11y/useSemanticElements: a listbox's groups are ARIA groups; a fieldset cannot sit in one.

import {
  CONVERSATION_NAME_CHARS,
  type ConversationTag,
  RenameConversation,
} from "@localdot/protocol";
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
  liveConversations,
  type Organize,
  organizeConversation,
  STATUS_LABEL,
  tagsInUse,
  useRecentConversations,
  whenLabel,
} from "../agent/conversation-list.ts";
import { searchConversations } from "../agent/conversation-search.ts";
import { DotLoader } from "../dot/DotLoader.tsx";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { Highlight } from "../replay/Highlight.tsx";
import { useTaskSearch } from "../replay/search-api.ts";
import { announce } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { TAG_NAMES, TagDot, TagMark } from "../ui/ConversationTag.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { useFlip } from "../ui/flip.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { MenuItem } from "../ui/Menu.tsx";
import { Popover, triggerProps } from "../ui/Popover.tsx";
import { SessionGlyph } from "../ui/SessionGlyph.tsx";
import { type SwipeAction, SwipeActions } from "../ui/SwipeActions.tsx";
import { TextField } from "../ui/TextField.tsx";
import { useVirtualRows } from "../ui/useVirtualRows.ts";
import { ConversationMenu } from "./ConversationMenu.tsx";
import { ConversationPeek, type Peek } from "./ConversationPeek.tsx";
import { DeleteConversationDialog } from "./DeleteConversationDialog.tsx";
import { LiveDeck } from "./LiveDeck.tsx";
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
  // A popover's compact list, or a phone's sheet: the conversations under way as cards over the
  // rest, rows a finger swipes to pin or archive and holds to preview, and a filter by colour tag.
  layout?: "popover" | "sheet";
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
  layout = "popover",
}: ConversationListProps) {
  const sheet = layout === "sheet";
  const listId = useId();
  const actionAnchor = useRef<HTMLElement | null>(null);
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
  // The sheet's colour filter, kept only while a conversation still has that tag.
  const [tag, setTag] = useState<ConversationTag | null>(null);
  const tags = useMemo(() => (sheet ? tagsInUse(all) : []), [sheet, all]);
  const tagged = tag && tags.includes(tag) ? tag : null;
  const shown = useMemo(
    () => (tagged ? all.filter((row) => row.entry.tag === tagged) : all),
    [all, tagged],
  );
  const found = useMemo(
    () => (query.trim() ? searchConversations(shown, query, matches.tasks) : null),
    [shown, query, matches.tasks],
  );
  // On the sheet the conversations under way are cards above the rest, until a search.
  const live = useMemo(
    () => (sheet && !found ? liveConversations(shown) : []),
    [sheet, found, shown],
  );
  const groups = useMemo(
    (): ConversationGroup[] =>
      found
        ? found.length
          ? [{ label: "Results", rows: found.map((match) => match.row) }]
          : []
        : groupConversations(live.length ? shown.filter((row) => !row.active) : shown, now),
    [found, shown, live, now],
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
  const body = useRef<HTMLDivElement>(null);
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
    const row = list.current?.querySelector<HTMLElement>("[data-active]");
    const port = body.current;
    // The sheet opens at its top, with the cards under way in view, and follows only the keys. It
    // scrolls only its list: scrolling the row into view would move the sheet too.
    if (sheet && !active) return;
    if (!sheet || !row || !port) {
      row?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      return;
    }
    const box = row.getBoundingClientRect();
    const view = port.getBoundingClientRect();
    if (box.top < view.top) port.scrollTop -= view.top - box.top;
    else if (box.bottom > view.bottom) port.scrollTop += box.bottom - view.bottom;
  }, [activeKey]);
  const pick = (row: ConversationRow) => {
    if (reason && row.entry.sessionId !== current) return;
    onPick(row.entry.sessionId, row.entry.sessions);
  };
  const running = (row: ConversationRow) =>
    row.active || !!row.entry.live || row.entry.sessions.includes(facts.live ?? "");
  const organize = (row: ConversationRow, change: Organize) =>
    organizeConversation(api, row.entry.sessionId, change).catch((failure) =>
      announce(
        "conversation",
        failure instanceof ApiError && failure.status === 409
          ? "This conversation can't be archived while its task is under way."
          : "That change couldn't be saved. Try again.",
        "assertive",
      ),
    );
  // A row or card held, or its More: it grows into its preview, and the menu opens under that.
  const [peek, setPeek] = useState<Peek | null>(null);
  const peekCard = useRef<HTMLDivElement>(null);
  const openPeek = (row: ConversationRow, from: HTMLElement) => {
    setAction(null);
    setPeek({ row, from });
  };
  const closeMenu = () => {
    setAction(null);
    setPeek(null);
  };
  // The cards, day headings, rows and the foot all glide to their new places together.
  useFlip(
    sheet ? body : NO_BODY,
    [...live.map((row) => row.entry.sessionId), ...flat.map((item) => item.key)].join(" "),
  );
  const swipes = (row: ConversationRow) => {
    const pinned = !!row.entry.pinned;
    const pin: SwipeAction = {
      label: pinned ? "Unpin" : "Pin",
      icon: pinned ? "pin-off" : "pin",
      onAction: () => void organize(row, { pinned: !pinned }),
    };
    const more: SwipeAction = {
      label: "More",
      icon: "more-horizontal",
      onAction: () => {
        const from = document.getElementById(optionId(row));
        if (from) openPeek(row, from);
      },
    };
    // Archiving or bringing back takes the row out of the list on show.
    const file: SwipeAction =
      view === "archived"
        ? {
            label: "Unarchive",
            icon: "archive-restore",
            leaves: true,
            onAction: () => void organize(row, { archived: false }),
          }
        : {
            label: "Archive",
            icon: "archive",
            leaves: true,
            onAction: () => void organize(row, { archived: true }),
          };
    return { leading: pin, trailing: running(row) ? [more] : [file, more] };
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

  // The name being typed in place, in its row or its card. An empty name gives the conversation
  // back its automatic one.
  const renameField = (row: ConversationRow) =>
    renaming && (
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
    );

  let content: ReactNode;
  if (recent.loading)
    content = <DotLoader className="conversations-loading" label="Loading your conversations" />;
  else if (recent.failed)
    content = (
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
    content = <EmptyState title="Nothing archived" icon="archive" />;
  else if (recent.entries.length === 0)
    content = (
      <EmptyState title="No conversations yet" icon="message-circle">
        Each conversation with dot is kept here.
      </EmptyState>
    );
  else if (ordered.length === 0 && live.length === 0 && (found || tagged))
    content = matches.pending ? (
      <DotLoader className="conversations-loading" label="Searching conversations" />
    ) : found ? (
      <EmptyState layout="start" icon="search" title={`No conversations match “${query.trim()}”`} />
    ) : (
      tagged && (
        <EmptyState
          layout="start"
          icon="tag"
          title={`No conversations have the ${TAG_NAMES[tagged].toLowerCase()} tag`}
        />
      )
    );
  else if (ordered.length === 0) content = null;
  else
    content = (
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
                data-flip={sheet ? `day ${item.label}` : undefined}
                role="presentation"
                className="conversations-day"
              >
                {item.label}
              </div>
            );
          const id = row.entry.sessionId;
          const isCurrent = id === current;
          const match = marked.get(id);
          const cells = (
            <>
              <div role="gridcell" className="conversations-main">
                {renaming?.id === id ? (
                  renameField(row)
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
                    setPeek(null);
                    setAction(row);
                  }}
                />
              </div>
            </>
          );
          return (
            <div
              key={id}
              ref={windowed.measure}
              data-index={index}
              data-flip={sheet ? id : undefined}
              aria-rowindex={ordered.indexOf(row) + 1}
              id={optionId(row)}
              role="row"
              aria-selected={row === activeRow}
              aria-current={isCurrent || undefined}
              aria-disabled={(!!reason && !isCurrent) || undefined}
              className="conversations-row"
              data-active={row === activeRow || undefined}
              data-current={isCurrent || undefined}
              data-menu={action?.entry.sessionId === id || undefined}
              onPointerMove={(event) => {
                // A finger moving over the rows is scrolling them, not choosing one.
                if (id !== activeKey && event.pointerType === "mouse") setActive(id);
              }}
            >
              {sheet && renaming?.id !== id ? (
                <SwipeActions
                  className="conversations-swipe"
                  {...swipes(row)}
                  onHold={() => {
                    const from = document.getElementById(optionId(row));
                    if (from) openPeek(row, from);
                  }}
                >
                  {cells}
                </SwipeActions>
              ) : (
                cells
              )}
            </div>
          );
        })}
        <div aria-hidden="true" style={{ height: windowed.after }} />
      </div>
    );

  const foot = (
    <div
      className="conversations-foot"
      data-loading={recent.loading || undefined}
      data-flip={sheet ? "foot" : undefined}
    >
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
  );

  return (
    <div className="conversations" data-layout={layout}>
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
      {tags.length > 0 && (
        <div className="conversations-tags" role="group" aria-label="Show only a colour tag">
          {tags.map((each) => (
            <Button
              key={each}
              variant="quiet"
              size="sm"
              className="conversations-tag"
              aria-pressed={tagged === each}
              onClick={() => setTag(tagged === each ? null : each)}
            >
              <TagDot tag={each} />
              {TAG_NAMES[each]}
            </Button>
          ))}
        </div>
      )}
      <div ref={body} className="conversations-body" aria-busy={recent.loading || matches.pending}>
        {live.length > 0 && (
          <LiveDeck
            rows={live}
            current={current}
            now={now}
            reason={reason}
            menuFor={peek ? undefined : action?.entry.sessionId}
            renaming={renaming?.id}
            renameField={renameField}
            onPick={pick}
            onMenu={(row, trigger) => {
              actionAnchor.current = trigger;
              setPeek(null);
              setAction(row);
            }}
            onPeek={openPeek}
          />
        )}
        {content}
        {sheet && foot}
      </div>
      <ConversationPeek
        peek={peek}
        now={now}
        cardRef={peekCard}
        onPlaced={() => {
          if (!peek) return;
          actionAnchor.current = peekCard.current;
          setAction(peek.row);
        }}
      />
      <ConversationMenu
        entry={action?.entry ?? null}
        anchor={actionAnchor}
        onClose={closeMenu}
        align={peek ? "start" : "end"}
        running={!!action && running(action)}
        onRename={() => {
          if (action)
            setRenaming({ id: action.entry.sessionId, name: action.title, was: action.title });
        }}
        onOrganize={(change) => {
          if (action) void organize(action, change);
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
      {!sheet && foot}
    </div>
  );
}

const NO_BODY = { current: null };

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
