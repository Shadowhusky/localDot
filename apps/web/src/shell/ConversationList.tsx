// biome-ignore-all lint/a11y/useFocusableInteractive: rows are reached through aria-activedescendant on the search field, which keeps focus.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: the search field takes the keys for every row.
// biome-ignore-all lint/a11y/useSemanticElements: a listbox's groups are ARIA groups; a fieldset cannot sit in one.

import {
  CONVERSATION_NAME_CHARS,
  type ConversationEntry,
  type ConversationTag,
  RenameConversation,
} from "@localdot/protocol";
import {
  type KeyboardEvent,
  type MouseEvent,
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
  tagsInUse,
  useRecentConversations,
  whenLabel,
} from "../agent/conversation-list.ts";
import { searchConversations } from "../agent/conversation-search.ts";
import { DotLoader } from "../dot/DotLoader.tsx";
import { t, tr } from "../i18n/index.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { Highlight } from "../replay/Highlight.tsx";
import { useTaskSearch } from "../replay/search-api.ts";
import { announce } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { CheckMark } from "../ui/CheckMark.tsx";
import { TAG_NAMES, TagDot } from "../ui/ConversationTag.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { useFlip } from "../ui/flip.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { MenuItem } from "../ui/Menu.tsx";
import { Popover, triggerProps } from "../ui/Popover.tsx";
import { type SwipeAction, SwipeActions } from "../ui/SwipeActions.tsx";
import { TextField } from "../ui/TextField.tsx";
import { useHandler } from "../ui/useHandler.ts";
import { useVirtualRows } from "../ui/useVirtualRows.ts";
import { ConversationAvatar } from "./ConversationAvatar.tsx";
import { ConversationMenu } from "./ConversationMenu.tsx";
import { ConversationPeek, type Peek } from "./ConversationPeek.tsx";
import { adds, SelectAll, SelectionActions } from "./ConversationSelection.tsx";
import { fileConversations } from "./conversation-leave.ts";
import { DeleteConversationDialog } from "./DeleteConversationDialog.tsx";
import { LiveDeck } from "./LiveDeck.tsx";
import { useConversationSelection } from "./useConversationSelection.ts";
import "../ui/conversations-layout.css";
import "./rails.css";

const GROUP_NAMES: Record<ConversationGroup["label"], string> = {
  Results: tr("Results"),
  Pinned: tr("Pinned"),
  Active: tr("Active"),
  Today: tr("Today"),
  Yesterday: tr("Yesterday"),
  Earlier: tr("Earlier"),
};

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
// the rows, as a picker's does. Select, a row's menu, or a row pressed with Cmd, Ctrl or Shift
// starts choosing several to act on together; Escape lets them go.
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
  // A row's menu stands against the popover's edge, or the sheet's, level with the row.
  const actionRow = useRef<HTMLElement | null>(null);
  const surface = useRef<HTMLElement | null>(null);
  const [action, setAction] = useState<ConversationRow | null>(null);
  const [deleting, setDeleting] = useState<readonly ConversationEntry[] | null>(null);
  // Select, then Cancel: where the confirmation for several opens and where focus goes after.
  const selectToggle = useRef<HTMLButtonElement>(null);
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
      setRenameError(t`Use one line of text for the name.`);
      return;
    }
    try {
      await api.post(`/api/conversations/${id}/title`, body.data);
      setRenameError(null);
      recent.retry();
    } catch {
      setRenameError(t`The new name couldn't be saved. Try again.`);
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
  // While choosing, every conversation is a row, in the order the list gives them.
  const listed = useMemo(
    () =>
      found
        ? found.map((match) => match.row)
        : groupConversations(shown, now).flatMap((group) => group.rows),
    [found, shown, now],
  );
  const selection = useConversationSelection(listed);
  if (!open && selection.selecting) selection.stop();
  // Escape anywhere in the popover or sheet lets the chosen go before it would close them. WebKit
  // leaves focus on the popover itself after a press on a row, outside the list.
  const root = useRef<HTMLDivElement>(null);
  const letGo = useHandler((event: globalThis.KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || deleting) return;
    const around = root.current?.closest("[role='dialog']") ?? root.current;
    if (!(event.target instanceof Node) || !around?.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    selection.stop();
  });
  useEffect(() => {
    if (!selection.selecting) return;
    document.addEventListener("keydown", letGo, true);
    return () => document.removeEventListener("keydown", letGo, true);
  }, [selection.selecting, letGo]);
  // On the sheet the conversations under way are cards above the rest, until a search.
  const live = useMemo(
    () => (sheet && !found && !selection.selecting ? liveConversations(shown) : []),
    [sheet, found, shown, selection.selecting],
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
  // A row chosen from its menu takes the focus once it is a checkbox: on the sheet that is a new
  // element, as the row no longer slides.
  const focusRow = useRef<ConversationRow | null>(null);
  useEffect(() => {
    const row = focusRow.current;
    if (!row) return;
    focusRow.current = null;
    document
      .getElementById(optionId(row))
      ?.querySelector<HTMLElement>(".conversations-pick")
      ?.focus();
  });
  const pick = (row: ConversationRow) => {
    if (reason && row.entry.sessionId !== current) return;
    onPick(row.entry.sessionId, row.entry.sessions);
  };
  const press = (row: ConversationRow, event: MouseEvent | KeyboardEvent) => {
    const id = row.entry.sessionId;
    if (selection.selecting) selection.press(id, event.shiftKey);
    else if (adds(event) || event.shiftKey) selection.start(id, event.shiftKey ? current : null);
    else pick(row);
  };
  const running = (row: ConversationRow) =>
    row.active || !!row.entry.live || row.entry.sessions.includes(facts.live ?? "");
  const organize = (row: ConversationRow, change: Organize) =>
    organizeConversation(api, row.entry.sessionId, change).catch((failure) =>
      announce(
        "conversation",
        failure instanceof ApiError && failure.status === 409
          ? t`This conversation can't be archived while its task is under way.`
          : t`That change couldn't be saved. Try again.`,
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
  const openMenu = (row: ConversationRow, trigger: HTMLElement, from: HTMLElement | null) => {
    actionAnchor.current = trigger;
    actionRow.current = from;
    surface.current = from?.closest(".ui-popup") ?? from?.closest(".conversations") ?? null;
    setPeek(null);
    setAction(row);
  };
  // The cards, day headings, rows and the foot all glide to their new places together. In the
  // popover what a search finds shows at once.
  useFlip(
    body,
    sheet || !found
      ? [...live.map((row) => row.entry.sessionId), ...flat.map((item) => item.key)].join(" ")
      : "results",
  );
  const swipes = (row: ConversationRow) => {
    const pinned = !!row.entry.pinned;
    const pin: SwipeAction = {
      label: pinned ? t`Unpin` : t`Pin`,
      icon: pinned ? "pin-off" : "pin",
      onAction: () => void organize(row, { pinned: !pinned }),
    };
    const more: SwipeAction = {
      label: t`More`,
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
            label: t`Unarchive`,
            icon: "archive-restore",
            leaves: true,
            onAction: () => void organize(row, { archived: false }),
          }
        : {
            label: t`Archive`,
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
      if (selection.selecting) press(activeRow, event);
      else pick(activeRow);
    }
  };

  // The name being typed in place, in its row or its card. An empty name gives the conversation
  // back its automatic one.
  const renameField = (row: ConversationRow) =>
    renaming && (
      <TextField
        size="sm"
        className="conversations-rename"
        aria-label={t`New name for ${row.title}`}
        placeholder={t`Automatic name`}
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
    content = <DotLoader className="conversations-loading" label={t`Loading your conversations`} />;
  else if (recent.failed)
    content = (
      <EmptyState
        title={t`Conversations couldn't load`}
        icon="circle-alert"
        actions={
          <Button size="sm" onClick={recent.retry}>
            {t`Try again`}
          </Button>
        }
      />
    );
  else if (recent.entries.length === 0 && view === "archived")
    content = <EmptyState title={t`Nothing archived`} icon="archive" />;
  else if (recent.entries.length === 0)
    content = (
      <EmptyState title={t`No conversations yet`} icon="message-circle">
        {t`Each conversation with dot is kept here.`}
      </EmptyState>
    );
  else if (ordered.length === 0 && live.length === 0 && (found || tagged))
    content = matches.pending ? (
      <DotLoader className="conversations-loading" label={t`Searching conversations`} />
    ) : found ? (
      <EmptyState
        layout="start"
        icon="search"
        title={t`No conversations match “${query.trim()}”`}
      />
    ) : (
      tagged && (
        <EmptyState
          layout="start"
          icon="tag"
          title={t`No conversations have the ${TAG_NAMES[tagged].toLowerCase()} tag`}
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
        aria-label={t`Recent conversations`}
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
                data-flip={`day ${item.label}`}
                role="presentation"
                className="conversations-day"
              >
                {GROUP_NAMES[item.label]}
              </div>
            );
          const id = row.entry.sessionId;
          const isCurrent = id === current;
          const match = marked.get(id);
          const choosing = selection.selecting;
          const chosen = selection.chosen(id);
          const cells = (
            <>
              <div role="gridcell" className="conversations-main">
                {renaming?.id === id ? (
                  renameField(row)
                ) : (
                  <Button
                    variant="quiet"
                    className="conversations-pick"
                    role={choosing ? "checkbox" : undefined}
                    aria-checked={choosing ? chosen : undefined}
                    disabledReason={!isCurrent && !choosing ? reason : undefined}
                    // While choosing, the whole row takes the press, its tick too.
                    onClick={(event) => {
                      if (!choosing) press(row, event);
                    }}
                  >
                    <ConversationAvatar row={row} labelled />
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
                {choosing ? (
                  <CheckMark checked={chosen} className="conversations-check" />
                ) : (
                  <IconButton
                    icon="more-horizontal"
                    size={28}
                    className="conversations-more"
                    label={t`Actions for ${row.title}`}
                    {...triggerProps("menu", action?.entry.sessionId === id)}
                    onClick={(event) =>
                      openMenu(row, event.currentTarget, event.currentTarget.closest("[role=row]"))
                    }
                  />
                )}
              </div>
            </>
          );
          return (
            <div
              key={id}
              ref={windowed.measure}
              data-index={index}
              data-flip={id}
              data-conversation={id}
              aria-rowindex={ordered.indexOf(row) + 1}
              id={optionId(row)}
              role="row"
              aria-selected={row === activeRow}
              aria-current={isCurrent || undefined}
              aria-disabled={(!!reason && !isCurrent && !choosing) || undefined}
              className="conversations-row"
              data-active={row === activeRow || undefined}
              data-current={isCurrent || undefined}
              data-menu={action?.entry.sessionId === id || undefined}
              onClick={choosing ? (event) => press(row, event) : undefined}
              onPointerMove={(event) => {
                // A finger moving over the rows is scrolling them, not choosing one.
                if (id !== activeKey && event.pointerType === "mouse") setActive(id);
              }}
              // The sheet's rows take a right click as a hold; the popover's open their menu.
              onContextMenu={(event) => {
                const more = event.currentTarget.querySelector<HTMLElement>(".conversations-more");
                if (sheet || !more || renaming?.id === id) return;
                event.preventDefault();
                openMenu(row, more, event.currentTarget);
              }}
            >
              {sheet && renaming?.id !== id && !choosing ? (
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
          {t`Recent conversations`}
        </Button>
      ) : (
        <>
          <Button variant="quiet" size="sm" icon="history" onClick={onReplay}>
            {t`See all in Replay`}
          </Button>
          {recent.archivedCount > 0 && (
            <Button variant="quiet" size="sm" icon="archive" onClick={() => setView("archived")}>
              {t`Archived (${recent.archivedCount})`}
            </Button>
          )}
        </>
      )}
    </div>
  );

  return (
    <div
      ref={root}
      className="conversations"
      data-layout={layout}
      data-selecting={selection.selecting || undefined}
    >
      <div className="conversations-search-row">
        <TextField
          size="sm"
          className="conversations-search"
          prefix={<Icon name="search" />}
          role="combobox"
          aria-label={t`Search conversations`}
          aria-expanded={ordered.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-haspopup="grid"
          aria-activedescendant={activeRow ? optionId(activeRow) : undefined}
          placeholder={t`Search conversations`}
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
        {(selection.selecting || all.length > 0) && (
          <Button
            ref={selectToggle}
            variant="quiet"
            size={sheet ? "md" : "sm"}
            className="conversations-select"
            onClick={() => (selection.selecting ? selection.stop() : selection.start())}
          >
            {selection.selecting ? t`Cancel` : t`Select`}
          </Button>
        )}
      </div>
      {selection.selecting && (
        <SelectAll
          shown={ordered.length}
          chosen={selection.picked.length}
          onChange={selection.all}
        />
      )}
      {reason && <p className="conversations-note">{reason}</p>}
      {renameError && (
        <p className="conversations-note" role="alert">
          {renameError}
        </p>
      )}
      {tags.length > 0 && (
        <div className="conversations-tags" role="group" aria-label={t`Show only a colour tag`}>
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
            onMenu={(row, trigger) => openMenu(row, trigger, null)}
            onPeek={openPeek}
          />
        )}
        {content}
        {sheet && !selection.selecting && foot}
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
        row={peek ? undefined : actionRow}
        list={peek ? undefined : surface}
        onClose={closeMenu}
        side={peek ? "bottom" : "right"}
        // A phone's sheet leaves no room beside it, so the menu hangs under the row, by its More.
        align={sheet && !peek ? "end" : "start"}
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
            announce("conversation", t`That change couldn't be saved. Try again.`, "assertive"),
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
          disabledReason={reason && action?.entry.sessionId !== current ? reason : undefined}
          onSelect={() => {
            if (action) pick(action);
          }}
        >
          {t`Open conversation`}
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
      {selection.selecting ? (
        <SelectionActions
          api={api}
          picked={selection.picked}
          running={running}
          onDelete={() => {
            actionAnchor.current = selectToggle.current;
            setDeleting(selection.picked.map((row) => row.entry));
          }}
          onDone={selection.stop}
        />
      ) : (
        !sheet && foot
      )}
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
        label={t`Conversations`}
        {...triggerProps("dialog", open)}
        onClick={() => setOpen((was) => !was)}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        side="bottom"
        align="end"
        label={t`Conversations`}
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
