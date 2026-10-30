import {
  type KeyboardEvent,
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
  type ConversationRow,
  conversationRows,
  type LiveFacts,
  pinActive,
  renameConversation,
  STATUS_LABEL,
  useRecentConversations,
  whenLabel,
} from "../agent/conversation-list.ts";
import type { ApiClient } from "../lib/api.ts";
import { announce } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { useFlip } from "../ui/flip.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { isApple } from "../ui/Kbd.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { matches, REDUCED_MOTION, useMediaQuery } from "../ui/media.ts";
import { tokenMs } from "../ui/motion.ts";
import { triggerProps } from "../ui/Popover.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { SessionGlyph } from "../ui/SessionGlyph.tsx";
import { TextField } from "../ui/TextField.tsx";
import { useTooltip } from "../ui/Tooltip.tsx";
import { useHandler } from "../ui/useHandler.ts";
import type { Layout } from "./layout.ts";
import { switchConversation } from "./switch-motion.ts";
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
}

// "Plan the trip, working, on screen, 2 min": what a screen reader calls a row.
function rowName(row: ConversationRow, now: Date): string {
  const parts = [row.title, STATUS_LABEL[row.status].toLowerCase()];
  if (row.entry.live?.onScreen) parts.push("on screen");
  parts.push(whenLabel(row.since, now).toLowerCase());
  return parts.join(", ");
}

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

// The conversations beside the stage (left rail): those under way first, with what dot is doing
// in each, then the rest, newest first. Collapsed it keeps only their status marks. It follows the
// daemon's changes as they come and shares its list with the conversations popover. The arrows
// move through the rows, Return takes one up, F2 renames one and Mod+\ collapses or expands it.
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
}: SessionRailProps) {
  const recent = useRecentConversations(api, true);
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
    () =>
      pinActive(conversationRows(recent.entries, facts)).map((row) => {
        const name = names.get(row.entry.sessionId);
        return name ? { ...row, title: name.title || row.title } : row;
      }),
    [recent.entries, facts, names],
  );
  const active = rows.filter((row) => row.active);
  const rest = rows.filter((row) => !row.active);
  const order = rows.map((row) => row.entry.sessionId);

  const buttons = useRef(new Map<string, HTMLButtonElement>());
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
      if (id) buttons.current.get(id)?.focus();
    } else if (event.key === "F2" && expanded) {
      event.preventDefault();
      setEditing(row.entry.sessionId);
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

  const item = (row: ConversationRow) => (
    <RailRow
      key={row.entry.sessionId}
      row={row}
      now={now}
      expanded={expanded}
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
      onMenu={(trigger) => {
        actionAnchor.current = trigger;
        setAction(row);
      }}
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
  else if (!recent.loading && rows.length === 0 && expanded)
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
      <ScrollArea ref={scroller} className="sessions-scroll" fade="both">
        {body}
        {active.length > 0 && (
          <RailGroup label="Active" expanded={expanded}>
            {active.map(item)}
          </RailGroup>
        )}
        {rest.length > 0 && (
          <RailGroup label="Recent" expanded={expanded}>
            {rest.map(item)}
          </RailGroup>
        )}
      </ScrollArea>
      <Menu
        open={action !== null}
        onClose={() => setAction(null)}
        anchor={actionAnchor}
        label="Conversation actions"
        align="start"
      >
        <MenuItem
          icon="type"
          kbd={["F2"]}
          onSelect={() => {
            if (action) setEditing(action.entry.sessionId);
          }}
        >
          Rename
        </MenuItem>
      </Menu>
    </nav>
  );
});

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
  now: Date;
  expanded: boolean;
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
  now,
  expanded,
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
  const { triggerProps: tip, tooltip } = useTooltip({
    content: expanded || blocked ? undefined : row.title,
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
            aria-describedby={row.activity && expanded ? activityId : undefined}
            aria-keyshortcuts={expanded ? "F2" : undefined}
            disabledReason={blocked}
            onFocus={onFocus}
            onKeyDown={onKeyDown}
            onClick={onPick}
          >
            <SessionGlyph status={row.status} />
            <span className="sessions-title">{row.title}</span>
            <span className="sessions-when num">
              {row.entry.live?.onScreen && <Icon name="monitor" size={12} />}
              {whenLabel(row.since, now)}
            </span>
            {row.activity && (
              <span className="sessions-activity" data-shown={expanded || undefined}>
                <span id={activityId} className="sessions-activity-text">
                  {row.activity}
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
