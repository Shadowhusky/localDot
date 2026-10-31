import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  arrangeConversations,
  type ConversationRow,
  conversationRows,
  type LiveFacts,
  type Organize,
  organizeConversation,
  renameConversation,
  STATUS_LABEL,
  useRecentConversations,
  whenLabel,
} from "../agent/conversation-list.ts";
import { type ConversationMatch, searchConversations } from "../agent/conversation-search.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { Highlight } from "../replay/Highlight.tsx";
import { useTaskSearch } from "../replay/search-api.ts";
import { announce } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { TAG_NAMES, TagMark } from "../ui/ConversationTag.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { useFlip } from "../ui/flip.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { isApple } from "../ui/Kbd.tsx";
import { matches, REDUCED_MOTION, useMediaQuery } from "../ui/media.ts";
import { tokenMs } from "../ui/motion.ts";
import { triggerProps } from "../ui/Popover.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { SessionGlyph } from "../ui/SessionGlyph.tsx";
import { TextField } from "../ui/TextField.tsx";
import { useTooltip } from "../ui/Tooltip.tsx";
import { useHandler } from "../ui/useHandler.ts";
import { ConversationMenu } from "./ConversationMenu.tsx";
import { DeleteConversationDialog } from "./DeleteConversationDialog.tsx";
import type { Layout } from "./layout.ts";
import { RailSearch } from "./RailSearch.tsx";
import { switchConversation } from "./switch-motion.ts";
import { DOCK_POINTER, useDockMagnify } from "./useDockMagnify.ts";
import "../ui/conversations-layout.css";
import "./rails.css";

const RAIL_KEYS = ["Mod", "\\"] as const;
// How often the ages beside the names move on.
const AGE_TICK_MS = 30_000;

export interface SessionRailProps {
  api: ApiClient;
  // The conversation on show, by its latest task.
  current: string | null;
  facts: LiveFacts;
  // Why another conversation can't be taken up now.
  reason?: string;
  // Showing names, or only the status marks.
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
  onPick(sessionId: string, sessions?: readonly string[]): void;
  onNew(): void;
  // Why a new conversation can't be started now.
  newReason?: string;
  onDeleted?(sessions: readonly string[]): void;
}

// "Plan the trip, blue tag, working, on screen, 2 min": what a screen reader calls a row.
function rowName(row: ConversationRow, now: Date): string {
  const parts = [row.title];
  if (row.entry.tag) parts.push(`${TAG_NAMES[row.entry.tag].toLowerCase()} tag`);
  parts.push(STATUS_LABEL[row.status].toLowerCase());
  if (row.entry.live?.onScreen) parts.push("on screen");
  parts.push(whenLabel(row.since, now).toLowerCase());
  return parts.join(", ");
}

// Names given here stand in until the list read after saving them comes back.
const withNames = (
  rows: ConversationRow[],
  names: ReadonlyMap<string, { title: string; saved: boolean }>,
) =>
  rows.map((row) => {
    const name = names.get(row.entry.sessionId);
    return name ? { ...row, title: name.title || row.title } : row;
  });

// Until the user chooses, the rail shows names only where the stage keeps its size beside them: on
// a wide screen, and on a tablet held sideways, where the stage is as wide as its height allows.
export function useRailExpandedByDefault(layout: Layout): boolean {
  const landscape = useMediaQuery("(orientation: landscape)");
  return layout === "wide" || (layout === "tablet" && landscape);
}

const isToggle = (event: globalThis.KeyboardEvent) =>
  !event.altKey &&
  !event.shiftKey &&
  (isApple() ? event.metaKey : event.ctrlKey) &&
  (event.code === "Backslash" || event.key === "\\");

// The conversations beside the stage (left rail): those pinned, then those under way, with what dot
// is doing in each, then the rest, newest first, and those archived out of sight below. Collapsed it
// keeps only their status marks and colour tags. A search at the top finds them by name and by what
// was said in them. It follows the daemon's changes as they come and shares its list with the
// conversations popover. The arrows move through the rows, Return takes one up, F2 renames one,
// Shift+F10 or a right click opens its menu and Mod+\ collapses or expands the rail.
export const SessionRail = memo(function SessionRail({
  api,
  current,
  facts,
  reason,
  expanded,
  onExpandedChange,
  onPick,
  onNew,
  newReason,
  onDeleted,
}: SessionRailProps) {
  const recent = useRecentConversations(api, true);
  const [query, setQuery] = useState("");
  const searching = expanded && !!query.trim();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const archive = useRecentConversations(
    api,
    expanded && (searching || (archiveOpen && recent.archivedCount > 0)),
    "archived",
  );
  // Collapsed, the rail has no room for what a search finds, so it lets the search go.
  if (!expanded && query) setQuery("");
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // A started or ended task, or another conversation on show, reads the list again at once.
  const seen = useRef(`${facts.live}:${current}`);
  useEffect(() => {
    const at = `${facts.live}:${current}`;
    if (seen.current === at) return;
    seen.current = at;
    recent.retry();
  });

  // Names given here, shown until the list read after saving them comes back.
  const [names, setNames] = useState<ReadonlyMap<string, { title: string; saved: boolean }>>(
    () => new Map(),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new read is the trigger.
  useEffect(() => {
    setNames((was) =>
      [...was.values()].some((name) => name.saved)
        ? new Map([...was].filter(([, name]) => !name.saved))
        : was,
    );
  }, [recent.entries]);
  const rows = useMemo(
    () => arrangeConversations(withNames(conversationRows(recent.entries, facts), names)),
    [recent.entries, facts, names],
  );
  const archived = useMemo(
    () => withNames(conversationRows(archive.entries, facts), names),
    [archive.entries, facts, names],
  );
  const content = useTaskSearch(api, searching ? query : "");
  const found = useMemo(
    () =>
      searching
        ? {
            recent: searchConversations(
              [...rows.pinned, ...rows.active, ...rows.rest],
              query,
              content.tasks,
            ),
            archived: searchConversations(archived, query, content.tasks),
          }
        : null,
    [searching, rows, archived, query, content.tasks],
  );
  const archivedShown = expanded && archiveOpen && !found ? archived : [];
  const listed = found
    ? [...found.recent, ...found.archived].map((match) => match.row)
    : [...rows.pinned, ...rows.active, ...rows.rest, ...archivedShown];
  const order = listed.map((row) => row.entry.sessionId);

  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const searchField = useRef<HTMLInputElement>(null);
  const [seek, setSeek] = useState(false);
  const resultsId = useId();
  const [editing, setEditing] = useState<string | null>(null);
  // A rename ended from the keyboard hands focus back to its row once the row is back.
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id || id === editing) return;
    refocus.current = null;
    buttons.current.get(id)?.focus();
  });
  const rename = async (row: ConversationRow, title: string | null, fromKeys: boolean) => {
    const id = row.entry.sessionId;
    if (fromKeys) refocus.current = id;
    setEditing(null);
    if (title === null || title.trim() === row.title) return;
    setNames((was) => new Map(was).set(id, { title: title.trim(), saved: false }));
    try {
      await renameConversation(api, id, title);
      setNames((was) => new Map(was).set(id, { title: title.trim(), saved: true }));
      recent.retry();
    } catch {
      setNames((was) => {
        const next = new Map(was);
        next.delete(id);
        return next;
      });
      announce("conversation", "The name couldn't be saved. Try again.", "assertive");
    }
  };

  const toggle = useHandler(() => onExpandedChange(!expanded));
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat || !isToggle(event)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggle]);

  const scroller = useRef<HTMLDivElement>(null);
  useFlip(scroller, order.join(" "));
  useSelectionGlide(scroller, current);
  const docked = useMediaQuery(DOCK_POINTER) && !expanded;
  useDockMagnify(scroller, docked);

  const [focused, setFocused] = useState<string | null>(null);
  const stop = order.includes(focused ?? "")
    ? focused
    : order.includes(current ?? "")
      ? current
      : (order[0] ?? null);
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, row: ConversationRow) => {
    const at = order.indexOf(row.entry.sessionId);
    const to =
      event.key === "ArrowDown"
        ? at + 1
        : event.key === "ArrowUp"
          ? at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? order.length - 1
              : undefined;
    if (to !== undefined) {
      event.preventDefault();
      const id = order[Math.max(0, Math.min(order.length - 1, to))];
      // Up from the first row goes back to the search.
      if (to < 0 && expanded) searchField.current?.focus();
      else if (id) buttons.current.get(id)?.focus();
    } else if (event.key === "F2" && expanded) {
      event.preventDefault();
      setEditing(row.entry.sessionId);
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      openMenu(row, event.currentTarget);
    }
  };
  const pick = (row: ConversationRow) => {
    const id = row.entry.sessionId;
    if (id === current) {
      onPick(id, row.entry.sessions);
      return;
    }
    const from = order.indexOf(current ?? "");
    switchConversation(
      () => onPick(id, row.entry.sessions),
      from === -1 || order.indexOf(id) > from ? "down" : "up",
    );
  };

  const actionAnchor = useRef<HTMLButtonElement | null>(null);
  const [action, setAction] = useState<ConversationRow | null>(null);
  const openMenu = (row: ConversationRow, trigger: HTMLButtonElement) => {
    actionAnchor.current = trigger;
    setAction(row);
  };
  // A right click anywhere along a row opens its menu: on any part of it, in the gaps between rows
  // and beside it, where the dock's lens already shows it as the mark under the pointer. The rest of
  // the list has no menu, and the browser's own would only stand in for one. A name being typed
  // keeps the browser's.
  const menuAt = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea")) return;
    event.preventDefault();
    const item =
      target?.closest<HTMLElement>("[data-flip]") ??
      rowLevelWith(event.currentTarget, event.clientY);
    const row = listed.find((each) => each.entry.sessionId === item?.dataset.flip);
    const trigger = row && buttons.current.get(row.entry.sessionId);
    if (row && trigger) openMenu(row, trigger);
  };
  const [deleting, setDeleting] = useState<ConversationRow | null>(null);
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
  const running = (row: ConversationRow) =>
    row.active || !!row.entry.live || row.entry.sessions.includes(facts.live ?? "");

  const item = (row: ConversationRow, match?: ConversationMatch) => (
    <RailRow
      key={row.entry.sessionId}
      row={row}
      match={match}
      now={now}
      expanded={expanded}
      named={docked}
      current={row.entry.sessionId === current}
      tabStop={row.entry.sessionId === stop}
      blocked={reason && row.entry.sessionId !== current ? reason : undefined}
      editing={row.entry.sessionId === editing}
      menuOpen={action?.entry.sessionId === row.entry.sessionId}
      register={(element) => {
        if (element) buttons.current.set(row.entry.sessionId, element);
        else buttons.current.delete(row.entry.sessionId);
      }}
      onFocus={() => setFocused(row.entry.sessionId)}
      onKeyDown={(event) => moveFocus(event, row)}
      onPick={() => pick(row)}
      onMenu={(trigger) => openMenu(row, trigger)}
      onRenamed={(title, fromKeys) => void rename(row, title, fromKeys)}
    />
  );

  let body = null;
  if (recent.failed)
    body = expanded ? (
      <EmptyState
        layout="start"
        icon="circle-alert"
        title="Conversations couldn't load"
        actions={
          <Button size="sm" variant="quiet" onClick={recent.retry}>
            Try again
          </Button>
        }
      />
    ) : (
      <IconButton
        icon="circle-alert"
        size={32}
        label="Conversations couldn't load. Try again"
        className="sessions-retry"
        onClick={recent.retry}
      />
    );
  else if (found && found.recent.length + found.archived.length === 0)
    body = (
      <EmptyState
        layout="start"
        icon="search"
        title={content.pending ? "Searching…" : `Nothing matches “${query.trim()}”`}
      />
    );
  else if (!recent.loading && order.length === 0 && recent.archivedCount === 0 && expanded)
    body = <EmptyState layout="start" title="No conversations yet" />;

  return (
    <nav className="sessions" aria-label="Conversations" data-expanded={expanded || undefined}>
      <div className="sessions-head">
        <IconButton
          icon="panel-left"
          size={32}
          label={expanded ? "Collapse conversations" : "Expand conversations"}
          kbd={RAIL_KEYS}
          onClick={toggle}
        />
      </div>
      <NewRow expanded={expanded} reason={newReason} onNew={onNew} />
      <RailSearch
        expanded={expanded}
        query={query}
        onQuery={setQuery}
        onOpen={() => {
          setSeek(true);
          onExpandedChange(true);
        }}
        focusOnShow={seek}
        onShown={() => setSeek(false)}
        onDown={() => {
          const id = order[0];
          if (id) buttons.current.get(id)?.focus();
        }}
        onEnter={() => {
          const first = found?.recent[0] ?? found?.archived[0];
          if (first) pick(first.row);
        }}
        inputRef={searchField}
        resultsId={resultsId}
      />
      <ScrollArea
        ref={scroller}
        id={resultsId}
        className="sessions-scroll"
        fade="both"
        onContextMenu={menuAt}
      >
        <div className="sessions-lists">
          {body}
          {found ? (
            <>
              {found.recent.length > 0 && (
                <RailGroup label="Results" expanded={expanded}>
                  {found.recent.map((match) => item(match.row, match))}
                </RailGroup>
              )}
              {found.archived.length > 0 && (
                <RailGroup label="Archived" expanded={expanded}>
                  {found.archived.map((match) => item(match.row, match))}
                </RailGroup>
              )}
            </>
          ) : (
            <>
              {rows.pinned.length > 0 && (
                <RailGroup label="Pinned" expanded={expanded}>
                  {rows.pinned.map((row) => item(row))}
                </RailGroup>
              )}
              {rows.active.length > 0 && (
                <RailGroup label="Active" expanded={expanded}>
                  {rows.active.map((row) => item(row))}
                </RailGroup>
              )}
              {rows.rest.length > 0 && (
                <RailGroup label="Recent" expanded={expanded}>
                  {rows.rest.map((row) => item(row))}
                </RailGroup>
              )}
              {expanded && recent.archivedCount > 0 && (
                <ArchivedGroup
                  count={recent.archivedCount}
                  open={archiveOpen}
                  onToggle={() => setArchiveOpen((was) => !was)}
                >
                  {archivedShown.map((row) => item(row))}
                </ArchivedGroup>
              )}
            </>
          )}
        </div>
      </ScrollArea>
      <ConversationMenu
        entry={action?.entry ?? null}
        anchor={actionAnchor}
        onClose={() => setAction(null)}
        side={expanded ? "bottom" : "right"}
        running={!!action && running(action)}
        renameKeys={["F2"]}
        onRename={() => {
          if (!action) return;
          onExpandedChange(true);
          setEditing(action.entry.sessionId);
        }}
        onOrganize={(change) => {
          if (action) void organize(action, change);
        }}
        onDelete={() => setDeleting(action)}
      />
      <DeleteConversationDialog
        api={api}
        conversation={deleting?.entry ?? null}
        anchor={actionAnchor}
        onClose={() => setDeleting(null)}
        onDeleted={onDeleted}
      />
    </nav>
  );
});

function ArchivedGroup({
  count,
  open,
  onToggle,
  children,
}: {
  count: number;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <Button
        variant="quiet"
        size="sm"
        className="sessions-archived"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        <span className="sessions-group-name">Archived</span>
        <span className="sessions-archived-count num">{count}</span>
      </Button>
      <ul id={id} className="sessions-list" aria-label="Archived">
        {children}
      </ul>
    </div>
  );
}

function RailGroup({
  label,
  expanded,
  children,
}: {
  label: string;
  expanded: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <div id={id} className="sessions-group-label" data-hidden={expanded ? undefined : ""}>
        <span className="sessions-group-name">{label}</span>
      </div>
      <ul className="sessions-list" aria-labelledby={id}>
        {children}
      </ul>
    </div>
  );
}

function NewRow({
  expanded,
  reason,
  onNew,
}: {
  expanded: boolean;
  reason?: string;
  onNew(): void;
}) {
  const { triggerProps: tip, tooltip } = useTooltip({
    content: expanded || reason ? undefined : "New conversation",
  });
  return (
    <div className="sessions-new">
      <Button
        {...tip.handlers}
        variant="quiet"
        className="sessions-row"
        aria-label="New conversation"
        disabledReason={reason}
        onClick={onNew}
      >
        <Icon name="compose" />
        <span className="sessions-title">New conversation</span>
      </Button>
      {tooltip}
    </div>
  );
}

interface RailRowProps {
  row: ConversationRow;
  // What a search found in it.
  match?: ConversationMatch | undefined;
  now: Date;
  expanded: boolean;
  // The rail's dock shows its name beside the mark, so it needs no tooltip.
  named: boolean;
  current: boolean;
  tabStop: boolean;
  blocked?: string;
  editing: boolean;
  menuOpen: boolean;
  register(element: HTMLButtonElement | null): void;
  onFocus(): void;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
  onPick(): void;
  onMenu(trigger: HTMLButtonElement): void;
  // The name given, or null to leave it as it was.
  onRenamed(title: string | null, fromKeys: boolean): void;
}

function RailRow({
  row,
  match,
  now,
  expanded,
  named,
  current,
  tabStop,
  blocked,
  editing,
  menuOpen,
  register,
  onFocus,
  onKeyDown,
  onPick,
  onMenu,
  onRenamed,
}: RailRowProps) {
  const activityId = useId();
  const name = rowName(row, now);
  const second = match?.snippet ?? row.activity;
  const { triggerProps: tip, tooltip } = useTooltip({
    content: expanded || named || blocked ? undefined : row.title,
  });
  return (
    <li
      className="sessions-item"
      data-flip={row.entry.sessionId}
      data-current={current || undefined}
      data-menu={menuOpen || undefined}
    >
      <span className="sessions-selection" aria-hidden="true" />
      {editing ? (
        <RenameField title={row.title} onRenamed={onRenamed} />
      ) : (
        <>
          <Button
            {...tip.handlers}
            ref={register}
            variant="quiet"
            className="sessions-row"
            tabIndex={tabStop ? 0 : -1}
            aria-label={name}
            aria-current={current || undefined}
            aria-describedby={second && expanded ? activityId : undefined}
            aria-keyshortcuts={expanded ? "F2 Shift+F10" : "Shift+F10"}
            disabledReason={blocked}
            onFocus={onFocus}
            onKeyDown={onKeyDown}
            onClick={onPick}
          >
            <span className="sessions-glyph">
              <SessionGlyph status={row.status} />
              <TagMark tag={row.entry.tag} />
            </span>
            <span className="sessions-title">
              {match ? <Highlight text={match.title} /> : row.title}
            </span>
            <span className="sessions-when num">
              {row.entry.live?.onScreen && <Icon name="monitor" size={12} />}
              {whenLabel(row.since, now)}
            </span>
            {second && (
              <span className="sessions-activity" data-shown={expanded || undefined}>
                <span id={activityId} className="sessions-activity-text">
                  {match?.snippet ? <Highlight text={match.snippet} before={24} /> : second}
                </span>
              </span>
            )}
          </Button>
          {tooltip}
          {expanded && (
            <IconButton
              icon="more-horizontal"
              size={24}
              tabIndex={-1}
              className="sessions-more"
              label={`Actions for ${row.title}`}
              {...triggerProps("menu", menuOpen)}
              onClick={(event) => onMenu(event.currentTarget)}
            />
          )}
        </>
      )}
    </li>
  );
}

function RenameField({
  title,
  onRenamed,
}: {
  title: string;
  onRenamed(title: string | null, fromKeys: boolean): void;
}) {
  const [value, setValue] = useState(title);
  const done = useRef(false);
  const finish = (save: boolean, fromKeys: boolean) => {
    if (done.current) return;
    done.current = true;
    onRenamed(save ? value : null, fromKeys);
  };
  return (
    <TextField
      size="sm"
      className="sessions-rename"
      aria-label="Conversation name"
      value={value}
      maxLength={200}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true, false)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false, true);
        }
      }}
    />
  );
}

// The row level with `y` on the page in `list`, as it shows now, or one the gap beside it parts
// from the next: the gap is 2 px, and up to half as wide again where the dock magnifies.
function rowLevelWith(list: HTMLElement, y: number): HTMLElement | undefined {
  let nearest: HTMLElement | undefined;
  let away = 2;
  for (const item of list.querySelectorAll<HTMLElement>(".sessions-item[data-flip]")) {
    const box = item.getBoundingClientRect();
    const distance = Math.max(0, box.top - y, y - box.bottom);
    if (distance < away) {
      nearest = item;
      away = distance;
    }
  }
  return nearest;
}

// The selected row's light glides from the row it lit before, so taking up another conversation
// reads as one movement. Under reduced motion it moves at once.
function useSelectionGlide(scroller: { current: HTMLElement | null }, current: string | null) {
  const last = useRef<{ current: string | null; top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    const light = element?.querySelector<HTMLElement>("[data-current] > .sessions-selection");
    if (!element || !light) {
      last.current = null;
      return;
    }
    const origin = element.getBoundingClientRect().top - element.scrollTop;
    const box = light.getBoundingClientRect();
    const top = box.top - origin;
    const was = last.current;
    if (
      was &&
      was.current !== current &&
      box.height > 0 &&
      typeof light.animate === "function" &&
      !matches(REDUCED_MOTION)
    ) {
      const style = getComputedStyle(light);
      const frames = [
        {
          transform: `translateY(${was.top - top}px) scaleY(${was.height / box.height})`,
          transformOrigin: "top",
        },
        { transform: "none", transformOrigin: "top" },
      ];
      const duration = tokenMs(style, "--dur-default", 470);
      try {
        light.animate(frames, {
          duration,
          easing: style.getPropertyValue("--ease-spring").trim() || "ease-out",
        });
      } catch {
        light.animate(frames, { duration, easing: "ease-out" });
      }
    }
    last.current = { current, top, height: box.height };
  });
}
