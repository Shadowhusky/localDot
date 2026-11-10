import {
  type AttentionItem,
  CONVERSATION_NAME_CHARS,
  type ConversationEntry,
  type ConversationTag,
  NOTIFY_COPY,
  notifyRouteOf,
  RenameConversation,
} from "@localdot/protocol";
import { clsx } from "clsx";
import {
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ConversationRow,
  type ConversationView,
  conversationRows,
  type LiveFacts,
  mostUrgent,
  type Organize,
  organizeConversation,
  STATUS_LABEL,
  tagsInUse,
  useRecentConversations,
  whenLabel,
} from "../agent/conversation-list.ts";
import { searchConversations } from "../agent/conversation-search.ts";
import { markdownToPlain } from "../agent/markdown.ts";
import { DotLoader } from "../dot/DotLoader.tsx";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { Highlight } from "../replay/Highlight.tsx";
import { useTaskSearch } from "../replay/search-api.ts";
import { announce } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { CheckMark } from "../ui/CheckMark.tsx";
import { TAG_NAMES, TagDot, TagMark } from "../ui/ConversationTag.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { useFlip } from "../ui/flip.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { attachLongPress } from "../ui/long-press.ts";
import { isMenuKey, Menu, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import { SessionGlyph } from "../ui/SessionGlyph.tsx";
import { type SwipeAction, SwipeActions } from "../ui/SwipeActions.tsx";
import { TextField } from "../ui/TextField.tsx";
import { useEscape } from "../ui/useEscape.ts";
import { ConversationAvatar } from "./ConversationAvatar.tsx";
import { ConversationMenu } from "./ConversationMenu.tsx";
import { ConversationPeek, type Peek } from "./ConversationPeek.tsx";
import { adds, SelectAll, SelectionActions } from "./ConversationSelection.tsx";
import { fileConversations } from "./conversation-leave.ts";
import { DeleteConversationDialog } from "./DeleteConversationDialog.tsx";
import { useConversationSelection } from "./useConversationSelection.ts";
import "../ui/conversations-layout.css";
import "../ui/phone-layout.css";
import "./rails.css";

// How far the list scrolls before something runs under the bar, then before the large title has gone.
const UNDER_PX = 2;
const TITLED_PX = 34;
const WHEN_EVERY_MS = 60_000;

export interface PhoneListProps {
  api: ApiClient;
  // The current conversation's latest task.
  current: string | null;
  facts: LiveFacts;
  // The tasks that want the user, and those finished since the user last looked.
  attention: readonly AttentionItem[];
  // Why another conversation can't be taken up now.
  reason?: string;
  // Beside the conversation it shows, the current one is marked.
  selecting?: boolean;
  onOpen(row: ConversationRow, from: HTMLElement | null): void;
  onNew(): void;
  newReason?: string;
  onReplay(): void;
  // Every conversation's screen and progress at once.
  onOverview?(): void;
  onDeleted?(sessions: readonly string[]): void;
  // This computer's name on the pill, and what the pill opens.
  computer: { name: string; onOpen?(): void; menu: ReactNode };
  // What the computer's state asks of the user, under the search.
  notice?: ReactNode;
}

// What a row says under its title: what dot is doing, what it wants, or what it last said.
export function rowLine(row: ConversationRow, item: AttentionItem | undefined): string {
  const said = row.entry.line ? markdownToPlain(row.entry.line) : undefined;
  if (row.activity) return row.activity;
  switch (row.status) {
    case "needs-you": {
      const route = item && notifyRouteOf(item.reason);
      const title = route ? NOTIFY_COPY[route.kind].title : "dot needs you";
      return said ? `${title}. ${said}` : `${title}.`;
    }
    case "waiting":
      return "Waiting for the computer";
    case "paused":
      return said ? `Paused. ${said}` : "Paused.";
    case "failed":
      return said ?? "This task failed.";
    case "stopped":
      return said ?? "You stopped this.";
    default:
      return said ?? row.entry.said?.trim() ?? "Ready when you are.";
  }
}

function RowMark({ row, unread }: { row: ConversationRow; unread: boolean }) {
  if (row.status === "working" || row.status === "waiting" || row.status === "paused")
    return <SessionGlyph status={row.status} size={14} />;
  if (row.status === "failed") return <SessionGlyph status="failed" size={14} />;
  if (unread && row.status !== "needs-you")
    return <span className="phone-unread" role="img" aria-label="Unread" />;
  return null;
}

function RailItem({
  row,
  selected,
  disabledReason,
  onOpen,
  onHold,
  onMenuKey,
}: {
  row: ConversationRow;
  selected: boolean;
  disabledReason?: string;
  onOpen(from: HTMLElement | null): void;
  onHold(from: HTMLElement): void;
  onMenuKey(event: KeyboardEvent<HTMLButtonElement>): void;
}) {
  const host = useRef<HTMLLIElement>(null);
  const holds = useRef(onHold);
  holds.current = onHold;
  const [holding, setHolding] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    return attachLongPress(element, {
      pressing: setHolding,
      hold: () => holds.current(element),
    });
  }, []);
  return (
    <li
      ref={host}
      className="phone-rail-item"
      data-flip={row.entry.sessionId}
      data-conversation={row.entry.sessionId}
      data-holding={holding || undefined}
    >
      <Button
        variant="quiet"
        className="phone-rail-button"
        aria-label={`${row.title}. ${STATUS_LABEL[row.status]}`}
        aria-current={selected || undefined}
        disabledReason={disabledReason}
        onKeyDown={onMenuKey}
        onClick={(event) =>
          onOpen(event.currentTarget.querySelector<HTMLElement>(".conversation-avatar"))
        }
      >
        <ConversationAvatar row={row} size={72} badged={false} tagged={false} />
        <span className="phone-rail-name">{row.title}</span>
      </Button>
    </li>
  );
}

// The conversations, a phone's home: those pinned in a rail at the top, then the rest with whichever
// needs the user first. A row slides aside to pin or archive and holds still for its menu. Select in
// the bar, or in a row's menu, starts choosing several to act on together, each pinned one a row.
export function PhoneList({
  api,
  current,
  facts,
  attention,
  reason,
  selecting = false,
  onOpen,
  onNew,
  newReason,
  onReplay,
  onOverview,
  onDeleted,
  computer,
  notice,
}: PhoneListProps) {
  const screen = useRef<HTMLElement>(null);
  const actionAnchor = useRef<HTMLElement | null>(null);
  const actionRow = useRef<HTMLElement | null>(null);
  const [action, setAction] = useState<ConversationRow | null>(null);
  const [deleting, setDeleting] = useState<readonly ConversationEntry[] | null>(null);
  // Select, then Cancel: where the confirmation for several opens and where focus goes after.
  const selectToggle = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string; was: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const editing = useRef(renaming);
  editing.current = renaming;
  const [view, setView] = useState<ConversationView>("recent");
  const recent = useRecentConversations(api, true, view);
  const [query, setQuery] = useState("");
  const matches = useTaskSearch(api, query);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), WHEN_EVERY_MS);
    return () => clearInterval(timer);
  }, []);
  const all = useMemo(() => conversationRows(recent.entries, facts), [recent.entries, facts]);
  const [tag, setTag] = useState<ConversationTag | null>(null);
  const tags = useMemo(() => tagsInUse(all), [all]);
  const tagged = tag && tags.includes(tag) ? tag : null;
  const shown = useMemo(
    () => (tagged ? all.filter((row) => row.entry.tag === tagged) : all),
    [all, tagged],
  );
  const found = useMemo(
    () => (query.trim() ? searchConversations(shown, query, matches.tasks) : null),
    [shown, query, matches.tasks],
  );
  const marked = useMemo(
    () => new Map(found?.map((match) => [match.row.entry.sessionId, match])),
    [found],
  );
  const listed = useMemo(
    () => (found ? found.map((match) => match.row) : mostUrgent(shown)),
    [found, shown],
  );
  const selection = useConversationSelection(listed);
  const pinned = useMemo(
    () => (found || selection.selecting ? [] : shown.filter((row) => row.entry.pinned)),
    [found, shown, selection.selecting],
  );
  const rows = useMemo(
    () =>
      found || selection.selecting ? listed : mostUrgent(shown.filter((row) => !row.entry.pinned)),
    [found, shown, listed, selection.selecting],
  );
  const attentionOf = useMemo(
    () => new Map(attention.map((item) => [item.sessionId, item])),
    [attention],
  );
  const body = useRef<HTMLDivElement>(null);
  useFlip(body, [...pinned, ...rows].map((row) => row.entry.sessionId).join(" "));

  const running = (row: ConversationRow) =>
    row.active || !!row.entry.live || row.entry.sessions.includes(facts.live ?? "");
  useEscape(selection.selecting && !deleting, selection.stop);
  const blocked = (row: ConversationRow) =>
    reason && row.entry.sessionId !== current ? reason : undefined;
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
  // A row held, or its More: it grows into its preview, and the menu opens under that.
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
  // The row's menu, beside the list and level with the row; focus goes back to `trigger`.
  const openMenu = (row: ConversationRow, trigger: HTMLElement) => {
    actionAnchor.current = trigger;
    actionRow.current = trigger.closest("li");
    setPeek(null);
    setAction(row);
  };
  // Where the list fills the screen a hold lifts the row into its preview; beside the conversation
  // it opens the same menu a right click, the menu key and More do.
  const hold = (row: ConversationRow, from: HTMLElement, trigger = from) => {
    if (selecting) openMenu(row, trigger);
    else openPeek(row, from);
  };
  const menuKey = (row: ConversationRow) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!isMenuKey(event)) return;
    event.preventDefault();
    openMenu(row, event.currentTarget);
  };
  const rowElement = (row: ConversationRow) =>
    body.current?.querySelector<HTMLElement>(
      `[data-conversation="${row.entry.sessionId}"] .phone-row`,
    ) ?? null;
  // A row chosen from its menu takes the focus once it is a checkbox, a new element as it no longer
  // slides.
  const focusRow = useRef<ConversationRow | null>(null);
  useEffect(() => {
    const row = focusRow.current;
    if (!row) return;
    focusRow.current = null;
    rowElement(row)?.focus();
  });
  const swipes = (row: ConversationRow) => {
    const isPinned = !!row.entry.pinned;
    const pin: SwipeAction = {
      label: isPinned ? "Unpin" : "Pin",
      icon: isPinned ? "pin-off" : "pin",
      onAction: () => void organize(row, { pinned: !isPinned }),
    };
    const more: SwipeAction = {
      label: "More",
      icon: "more-horizontal",
      onAction: () => {
        const from = rowElement(row);
        if (from) hold(row, from);
      },
    };
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
  const rename = async () => {
    const was = editing.current;
    if (!was) return;
    editing.current = null;
    setRenaming(null);
    if (was.name.trim() === was.was) return;
    const parsed = RenameConversation.safeParse({ title: was.name.trim() || null });
    if (!parsed.success) {
      setRenameError("Use one line of text for the name.");
      return;
    }
    try {
      await api.post(`/api/conversations/${was.id}/title`, parsed.data);
      setRenameError(null);
      recent.retry();
    } catch {
      setRenameError("The new name couldn't be saved. Try again.");
    }
  };
  const bar = useRef<HTMLDivElement>(null);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const top = event.currentTarget.scrollTop;
    bar.current?.toggleAttribute("data-under", top > UNDER_PX);
    bar.current?.toggleAttribute("data-titled", top > TITLED_PX);
  };
  const [pillOpen, setPillOpen] = useState(false);
  const pill = useRef<HTMLButtonElement>(null);

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
      <EmptyState
        title="No conversations yet"
        icon="message-circle"
        actions={
          <Button variant="primary" disabledReason={newReason} onClick={onNew}>
            New conversation
          </Button>
        }
      >
        Each conversation with dot is kept here.
      </EmptyState>
    );
  else if (rows.length === 0 && pinned.length === 0)
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
  else
    content = (
      <ul className="phone-rows" aria-label="Recent conversations">
        {rows.map((row) => {
          const id = row.entry.sessionId;
          const match = marked.get(id);
          const item = attentionOf.get(id);
          const line = rowLine(row, item);
          const unread = !!item && item.level !== "needs_you" && id !== current;
          const choosing = selection.selecting;
          const chosen = selection.chosen(id);
          const button = (
            <Button
              variant="quiet"
              className={clsx("phone-row", selecting && id === current && "phone-row-selected")}
              data-status={row.status}
              data-unread={unread || undefined}
              role={choosing ? "checkbox" : undefined}
              aria-checked={choosing ? chosen : undefined}
              aria-label={`${row.title}. ${STATUS_LABEL[row.status]}. ${line}`}
              aria-current={id === current || undefined}
              disabledReason={choosing ? undefined : blocked(row)}
              onKeyDown={choosing ? undefined : menuKey(row)}
              onClick={(event) => {
                if (choosing) selection.press(id, event.shiftKey);
                else if (adds(event) || event.shiftKey)
                  selection.start(id, event.shiftKey ? current : null);
                else
                  onOpen(
                    row,
                    event.currentTarget.querySelector<HTMLElement>(".conversation-avatar"),
                  );
              }}
            >
              <span className="phone-row-avatar">
                <ConversationAvatar row={row} size={64} badged={false} tagged={false} />
              </span>
              <span className="phone-row-main">
                <span className="phone-row-head">
                  <span className="phone-row-title">
                    {match ? <Highlight text={match.title} /> : row.title}
                  </span>
                  <time className="phone-row-time num" dateTime={row.since}>
                    {whenLabel(row.since, now)}
                  </time>
                </span>
                <span className="phone-row-foot">
                  <span className="phone-row-line">
                    {match?.snippet ? <Highlight text={match.snippet} before={32} /> : line}
                  </span>
                  <span className="phone-row-mark">
                    <RowMark row={row} unread={unread} />
                  </span>
                </span>
              </span>
              {choosing && <CheckMark checked={chosen} className="phone-row-check" />}
            </Button>
          );
          return (
            <li
              key={id}
              className="phone-row-wrap"
              data-conversation={id}
              data-flip={id}
              data-status={row.status}
            >
              {renaming?.id === id ? (
                <div className="phone-row-renaming">
                  <TextField
                    size="sm"
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
                </div>
              ) : choosing ? (
                button
              ) : (
                <SwipeActions
                  className="phone-row-swipe"
                  {...swipes(row)}
                  onHold={() => {
                    const from = rowElement(row);
                    if (from) hold(row, from);
                  }}
                >
                  {button}
                </SwipeActions>
              )}
              <TagMark tag={row.entry.tag} />
              {!choosing && (
                <IconButton
                  className="phone-row-actions"
                  icon="more-horizontal"
                  size={28}
                  label={`Actions for ${row.title}`}
                  {...triggerProps("menu", action?.entry.sessionId === id && !peek)}
                  onClick={(event) => openMenu(row, event.currentTarget)}
                />
              )}
            </li>
          );
        })}
      </ul>
    );

  return (
    <section
      ref={screen}
      className="phone-list-screen"
      aria-label="Conversations"
      data-selecting={selection.selecting || undefined}
    >
      <div ref={bar} className="phone-bar phone-list-bar">
        <div className="phone-bar-glass" />
        <div className="phone-list-inline-title" aria-hidden="true">
          Conversations
        </div>
        <div className="phone-bar-row phone-list-bar-row">
          {selection.selecting ? (
            <SelectAll
              shown={rows.length}
              chosen={selection.picked.length}
              onChange={selection.all}
            />
          ) : (
            <>
              <Button
                ref={pill}
                variant="secondary"
                round
                icon="monitor"
                className="phone-pill"
                aria-label={`${computer.name}: this computer and app settings`}
                {...triggerProps("menu", pillOpen)}
                onClick={() => {
                  computer.onOpen?.();
                  setPillOpen(true);
                }}
              >
                <span className="phone-pill-name">{computer.name}</span>
                <Icon name="chevron-down" size={12} className="phone-pill-chevron" />
              </Button>
              <Menu
                open={pillOpen}
                onClose={() => setPillOpen(false)}
                anchor={pill}
                side="bottom"
                align="start"
                label="This computer and app settings"
              >
                {computer.menu}
              </Menu>
            </>
          )}
          {(selection.selecting || all.length > 0) && (
            <Button
              ref={selectToggle}
              variant="quiet"
              className="phone-select"
              onClick={() => (selection.selecting ? selection.stop() : selection.start())}
            >
              {selection.selecting ? "Cancel" : "Select"}
            </Button>
          )}
          {!selection.selecting && onOverview && (
            <IconButton
              size={36}
              round
              icon="layout-dashboard"
              label="Overview"
              className="phone-overview"
              onClick={onOverview}
            />
          )}
          {!selection.selecting && (
            <IconButton
              size={36}
              round
              variant="filled"
              icon="compose"
              label="New conversation"
              disabledReason={newReason}
              onClick={onNew}
            />
          )}
        </div>
      </div>
      <div className="phone-list-scroll" onScroll={onScroll}>
        <h1 className="phone-large-title">Conversations</h1>
        <TextField
          className="phone-search"
          filled
          prefix={<Icon name="search" />}
          aria-label="Search conversations"
          placeholder="Search"
          enterKeyHint="go"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {notice}
        {reason && <p className="conversations-note">{reason}</p>}
        {renameError && (
          <p className="conversations-note" role="alert">
            {renameError}
          </p>
        )}
        {tags.length > 0 && (
          // biome-ignore lint/a11y/useSemanticElements: a row of toggles, not a form's fieldset.
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
        <div ref={body} className="phone-list-body" aria-busy={recent.loading || matches.pending}>
          {pinned.length > 0 && (
            <ul className="phone-rail" aria-label="Pinned">
              {pinned.map((row) => (
                <RailItem
                  key={row.entry.sessionId}
                  row={row}
                  selected={row.entry.sessionId === current}
                  disabledReason={blocked(row)}
                  onOpen={(from) => onOpen(row, from)}
                  onHold={(from) => hold(row, from, from.querySelector("button") ?? from)}
                  onMenuKey={menuKey(row)}
                />
              ))}
            </ul>
          )}
          {content}
          {!selection.selecting && (
            <div
              className="conversations-foot"
              data-flip="foot"
              data-loading={recent.loading || undefined}
            >
              {view === "archived" ? (
                <Button
                  variant="quiet"
                  size="sm"
                  icon="chevron-left"
                  onClick={() => setView("recent")}
                >
                  Recent conversations
                </Button>
              ) : (
                <>
                  <Button variant="quiet" size="sm" icon="history" onClick={onReplay}>
                    See all in Replay
                  </Button>
                  {recent.archivedCount > 0 && (
                    <Button
                      variant="quiet"
                      size="sm"
                      icon="archive"
                      onClick={() => setView("archived")}
                    >
                      Archived ({recent.archivedCount})
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {selection.selecting && (
        <SelectionActions
          className="phone-select-actions"
          api={api}
          picked={selection.picked}
          running={running}
          onDelete={() => {
            actionAnchor.current = selectToggle.current;
            setDeleting(selection.picked.map((row) => row.entry));
          }}
          onDone={selection.stop}
        />
      )}
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
        row={peek ? undefined : actionRow}
        list={peek ? undefined : screen}
        onClose={closeMenu}
        side={peek ? "bottom" : "right"}
        align="start"
        running={!!action && running(action)}
        onRename={() => {
          if (action)
            setRenaming({ id: action.entry.sessionId, name: action.title, was: action.title });
        }}
        onOrganize={(change) => {
          if (action)
            fileConversations(
              [action.entry.sessionId],
              change,
              () => void organize(action, change),
            );
        }}
        onLook={(entry, look) => {
          organizeConversation(api, entry.sessionId, { look }).catch(() =>
            announce("conversation", "That change couldn't be saved. Try again.", "assertive"),
          );
        }}
        onDelete={() => setDeleting(action && [action.entry])}
        onStartSelecting={() => {
          if (!action) return;
          selection.start(action.entry.sessionId);
          focusRow.current = action;
        }}
      >
        <MenuItem
          icon="message-circle"
          disabledReason={action ? blocked(action) : undefined}
          onSelect={() => {
            if (action) onOpen(action, null);
          }}
        >
          Open conversation
        </MenuItem>
      </ConversationMenu>
      <DeleteConversationDialog
        api={api}
        conversations={deleting}
        anchor={actionAnchor}
        onClose={() => setDeleting(null)}
        onDeleted={onDeleted}
        onRowsGone={selection.drop}
      />
    </section>
  );
}
