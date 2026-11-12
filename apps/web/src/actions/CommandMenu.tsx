import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "../i18n/index.ts";
import { Kbd } from "../ui/Kbd.tsx";
import { ActionList, rowId, type ShownRow } from "./ActionList.tsx";
import {
  type Action,
  type ActionChoice,
  type ActionInput,
  type ActionRow,
  actionRow,
  asksMore,
  type CommandText,
  commandText,
  findCommand,
  rowInput,
  slashRows,
} from "./actions.ts";

interface Loaded {
  readonly id: string;
  readonly choices?: readonly ActionChoice[];
  readonly failed?: boolean;
}

export interface CommandMenuOptions {
  actions: readonly Action[];
  // Puts text in the field, as typed.
  write(text: string): void;
  problem(text: string): void;
  run(action: Action, input: Omit<ActionInput, "trigger">): void;
}

export function shownSlashRow(row: ActionRow): ShownRow {
  const { action } = row;
  if (row.kind === "choice")
    return {
      key: row.key,
      label: row.choice.label,
      note: row.choice.unavailable ?? row.choice.detail,
      current: row.choice.current,
      unavailable: !!row.choice.unavailable,
    };
  if (row.kind === "text")
    return {
      key: row.key,
      label: action.title,
      note: `“${row.text}”`,
      unavailable: !!action.unavailable,
    };
  return {
    key: row.key,
    label: `/${action.command}`,
    hint: action.hint,
    note: action.unavailable ?? action.description,
    unavailable: !!action.unavailable,
  };
}

const MENU_MOST = 336;
const MENU_LEAST = 88;
const MENU_MARGIN = 8;

// The list opens upward from the field. It takes the room the screen has left above the field, on a
// short phone with its keyboard up too, and stays clear of the island, which holds Stop.
function useRoomAbove(menu: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const element = menu.current;
      const card = element?.parentElement;
      if (!element || !card) return;
      const below = card.getBoundingClientRect().top - MENU_MARGIN;
      const box = element.getBoundingClientRect();
      const island = document.querySelector(".island")?.getBoundingClientRect();
      const top = Math.max(
        window.visualViewport?.offsetTop ?? 0,
        island?.height &&
          island.left < box.right &&
          island.right > box.left &&
          island.bottom < below
          ? island.bottom
          : 0,
      );
      const room = Math.round(below - top - MENU_MARGIN);
      element.style.maxHeight = `${Math.max(MENU_LEAST, Math.min(MENU_MOST, room))}px`;
    };
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    fit();
    const view = window.visualViewport;
    view?.addEventListener("resize", later);
    view?.addEventListener("scroll", later);
    window.addEventListener("resize", later);
    const card = menu.current?.parentElement;
    const grows = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    if (card) grows?.observe(card);
    return () => {
      cancelAnimationFrame(frame);
      view?.removeEventListener("resize", later);
      view?.removeEventListener("scroll", later);
      window.removeEventListener("resize", later);
      grows?.disconnect();
    };
  }, [menu, open]);
}

// The composer's slash commands: "/" at the start of the field lists them, the field keeps focus and
// its keys drive the list. Nothing that reads as a command reaches dot unless the user says so twice.
export function useCommandMenu(options: CommandMenuOptions) {
  const latest = useRef(options);
  latest.current = options;
  const { actions } = options;
  const listId = useId();
  const [typed, setTyped] = useState<CommandText | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The command-shaped text that matched no command and was let through once it was said.
  const armed = useRef<string | null>(null);
  const command = typed?.spaced ? findCommand(actions, typed.name) : undefined;
  const loader = typeof command?.choices === "function" ? command.id : undefined;
  useEffect(() => {
    const load = latest.current.actions.find((action) => action.id === loader)?.choices;
    if (!loader || typeof load !== "function") return;
    const abort = new AbortController();
    setLoaded({ id: loader });
    load(abort.signal).then(
      (choices) => {
        if (!abort.signal.aborted) setLoaded({ id: loader, choices });
      },
      () => {
        if (!abort.signal.aborted) setLoaded({ id: loader, failed: true });
      },
    );
    return () => abort.abort();
  }, [loader]);
  const choices = loader && loaded?.id === loader ? loaded : undefined;
  const waiting = !!loader && !choices?.choices;
  const rows = useMemo(
    () => (typed && !waiting ? slashRows(actions, typed, choices?.choices) : []),
    [actions, typed, choices, waiting],
  );
  const open = !!typed && !dismissed;
  const box = useRef<HTMLDivElement>(null);
  useRoomAbove(box, open);
  const at = rows.length ? Math.min(active, rows.length - 1) : -1;

  // Each change of the field's text; a message's draws nothing.
  const changed = (value: string) => {
    if (armed.current !== null && armed.current !== value) armed.current = null;
    const next = commandText(value);
    if (next?.name === typed?.name && next?.spaced === typed?.spaced && next?.arg === typed?.arg)
      return;
    setTyped(next);
    setActive(0);
    setDismissed(false);
  };
  const complete = (row: ActionRow) => {
    const name = row.action.command;
    if (row.kind === "action") latest.current.write(`/${name} `);
    else if (row.kind === "choice") latest.current.write(`/${name} ${row.choice.label}`);
  };
  const choose = (row: ActionRow, from: CommandText | null) => {
    if (!from?.spaced && row.kind === "action" && asksMore(row.action) && !row.action.unavailable)
      return complete(row);
    const given = rowInput(row, from ?? undefined);
    if ("problem" in given) latest.current.problem(given.problem);
    else latest.current.run(row.action, given);
  };
  // Enter, Tab, the arrows and Escape while the list shows; true when the key was the list's.
  const key = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    if (!rows.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((at + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
      return true;
    }
    const row = rows[at];
    if (!row) return false;
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      complete(row);
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      choose(row, typed);
      return true;
    }
    return false;
  };
  // Send, with the list shown or not: a command runs, words that only look like one go to dot once
  // the user sends them a second time. "send" when the text is a message.
  const submit = (value: string): "send" | "handled" => {
    const now = commandText(value);
    if (!now) return "send";
    const action = findCommand(latest.current.actions, now.name);
    if (!action) {
      if (armed.current === value) {
        armed.current = null;
        return "send";
      }
      armed.current = value;
      setDismissed(true);
      latest.current.problem(
        t`There's no /${now.name} command. Send again to send it to dot as you wrote it.`,
      );
      return "handled";
    }
    const own = slashRows(latest.current.actions, now, choices?.choices);
    const only = own.length === 1 && own[0]?.kind === "choice" ? own[0] : undefined;
    choose(own.find((row) => row.kind === "text") ?? only ?? actionRow(action), now);
    return "handled";
  };
  const empty = !typed
    ? ""
    : !typed.spaced || !findCommand(actions, typed.name)
      ? t`There's no /${typed.name} command. Send it twice to give it to dot as a message.`
      : waiting
        ? choices?.failed
          ? t`Couldn't load the list. Try again.`
          : t`Loading…`
        : t`Nothing matches.`;
  const view = open && (
    <div ref={box} className="ui-picker-popover command-menu" data-command-menu="">
      {rows.length > 0 ? (
        <ActionList
          id={listId}
          label={t`Commands`}
          compact
          rows={rows.map(shownSlashRow)}
          active={at}
          onActive={setActive}
          onPick={(index) => {
            const row = rows[index];
            if (row) choose(row, typed);
          }}
        />
      ) : (
        <p className="command-menu-empty" role="status">
          {empty}
        </p>
      )}
      <div className="command-menu-foot" aria-hidden="true">
        <span>
          <Kbd keys={["ArrowUp"]} />
          <Kbd keys={["ArrowDown"]} /> {t`choose`}
        </span>
        <span>
          <Kbd keys={["Tab"]} /> {t`complete`}
        </span>
        <span>
          <Kbd keys={["Enter"]} /> {t`run`}
        </span>
      </div>
    </div>
  );
  return {
    view,
    changed,
    key,
    submit,
    // The command the text names in full, which Send runs.
    command: typed ? findCommand(actions, typed.name) : undefined,
    field: {
      "aria-controls": open && rows.length ? listId : undefined,
      "aria-activedescendant": open && at >= 0 ? rowId(listId, at) : undefined,
    },
  };
}
