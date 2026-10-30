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
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { isApple, Kbd } from "../ui/Kbd.tsx";
import { LayerPortal, useExit, useLayer } from "../ui/LayerStack.tsx";
import { useScrim } from "../ui/scrim.ts";
import { lockScroll } from "../ui/scroll-lock.ts";
import { TextField } from "../ui/TextField.tsx";
import { showToast } from "../ui/Toast.tsx";
import { ActionList, rowId, type ShownRow } from "./ActionList.tsx";
import {
  type Action,
  type ActionChoice,
  type ActionRow,
  actionFit,
  actionRow,
  argumentRows,
  asksMore,
  choiceFit,
  recentActions,
  rememberAction,
  rowInput,
} from "./actions.ts";
import { paletteKey, SHORTCUTS } from "./shortcuts.ts";

export type PalettePage = "actions" | "shortcuts";

// Opens the palette from the keyboard, wherever focus is.
export function usePaletteKeys(open: (page: PalettePage) => void, enabled: boolean) {
  const latest = useRef({ open, enabled });
  latest.current = { open, enabled };
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (!latest.current.enabled || event.defaultPrevented) return;
      const asked = paletteKey(event, isApple());
      if (!asked) return;
      event.preventDefault();
      latest.current.open(asked === "open" ? "actions" : "shortcuts");
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
}

interface PaletteProps {
  open: boolean;
  page: PalettePage;
  actions: readonly Action[];
  // What the palette offers before anything is typed, besides what was run lately.
  suggested: readonly string[];
  onClose(): void;
}

// Mod+K: one field that finds any action, its choices among them, and runs it.
export function CommandPalette(props: PaletteProps) {
  const root = useRef<HTMLDivElement>(null);
  const { mounted, closing } = useExit(props.open, root);
  return mounted ? <PaletteLayer {...props} root={root} closing={closing} /> : null;
}

const shownAction = (action: Action, section?: string): ShownRow => ({
  key: action.id,
  label: action.title,
  hint: action.command ? `/${action.command}` : undefined,
  note: action.unavailable ?? action.description,
  icon: action.icon,
  keys: action.keys,
  unavailable: !!action.unavailable,
  section,
});

function shownRow(row: ActionRow, inPage: boolean): ShownRow {
  if (row.kind === "action") return shownAction(row.action);
  if (row.kind === "text")
    return { key: row.key, label: row.action.title, note: `“${row.text}”`, icon: row.action.icon };
  const detail = inPage
    ? row.choice.detail
    : [row.action.title, row.choice.detail].filter(Boolean).join(" · ");
  return {
    key: row.key,
    label: row.choice.label,
    note: row.choice.unavailable ?? detail,
    icon: inPage ? undefined : row.action.icon,
    current: row.choice.current,
    unavailable: !!row.choice.unavailable,
  };
}

function PaletteLayer({
  open,
  page: opened,
  actions,
  suggested,
  onClose,
  root,
  closing,
}: PaletteProps & { root: RefObject<HTMLDivElement | null>; closing: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const listId = useId();
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // An action that asks for words or a choice, or the shortcuts.
  const [page, setPage] = useState<Action | "shortcuts" | null>(
    opened === "shortcuts" ? "shortcuts" : null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, readonly ActionChoice[]>>(new Map());
  const opener = useRef<HTMLElement | null>(null);
  const [recent] = useState(recentActions);
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement && !opener.current)
      opener.current = document.activeElement;
  }, [open]);
  // Asked again for the other page while open.
  const [asked, setAsked] = useState(opened);
  if (asked !== opened) {
    setAsked(opened);
    setPage(opened === "shortcuts" ? "shortcuts" : null);
    setQuery("");
  }
  const scrim = useScrim(() => {
    if (!closing) onClose();
  });
  const back = () => {
    setPage(null);
    setQuery("");
    setProblem(null);
  };
  useLayer({
    active: !closing,
    root,
    panel,
    trap: true,
    modal: true,
    onEscape: () => (page ? back() : onClose()),
    initialFocus: () => field.current ?? undefined,
  });
  useEffect(() => lockScroll(), []);
  // The choices found by searching, read once each time the palette opens.
  const searchable = useMemo(
    () => actions.filter((action) => action.searchable && typeof action.choices === "function"),
    [actions],
  );
  const searchKey = searchable.map((action) => action.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the actions' ids say what to read
  useEffect(() => {
    if (closing) return;
    const abort = new AbortController();
    for (const action of searchable)
      if (typeof action.choices === "function")
        action.choices(abort.signal).then(
          (choices) => {
            if (!abort.signal.aborted) setLoaded((was) => new Map([...was, [action.id, choices]]));
          },
          () => {},
        );
    return () => abort.abort();
  }, [searchKey, closing]);

  const pageAction = page && page !== "shortcuts" ? page : null;
  const live = pageAction
    ? (actions.find((action) => action.id === pageAction.id) ?? pageAction)
    : null;
  const rows = useMemo((): { rows: ActionRow[]; shown: ShownRow[] } => {
    if (page === "shortcuts") return { rows: [], shown: [] };
    if (live) {
      const own = argumentRows(live, query, loaded.get(live.id));
      return { rows: own, shown: own.map((row) => shownRow(row, true)) };
    }
    if (!query.trim()) {
      const byId = new Map(actions.map((action) => [action.id, action]));
      const picked = [
        ...recent.flatMap((id) => (byId.get(id) ? [{ id, section: "Recent" }] : [])),
        ...suggested
          .filter((id) => !recent.includes(id) && byId.has(id))
          .map((id) => ({ id, section: "Suggested" })),
      ];
      const own = picked.map(({ id }) => actionRow(byId.get(id) as Action));
      return {
        rows: own,
        shown: picked.map(({ id, section }, index) =>
          shownAction(
            byId.get(id) as Action,
            index === 0 || picked[index - 1]?.section !== section ? section : undefined,
          ),
        ),
      };
    }
    const found = [
      ...actions.map((action) => ({ row: actionRow(action), score: actionFit(action, query) })),
      ...actions
        .filter((action) => action.searchable)
        .flatMap((action) =>
          (typeof action.choices === "function"
            ? (loaded.get(action.id) ?? [])
            : (action.choices ?? [])
          ).map((choice) => ({
            row: {
              kind: "choice",
              key: `${action.id}:${choice.value}`,
              action,
              choice,
            } as ActionRow,
            score: choiceFit(choice, query),
          })),
        ),
    ]
      .map((entry, index) => ({ ...entry, index }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 60)
      .map((entry) => entry.row);
    return { rows: found, shown: found.map((row) => shownRow(row, false)) };
  }, [page, live, query, loaded, actions, recent, suggested]);
  const at = rows.rows.length ? Math.min(active, rows.rows.length - 1) : -1;

  const run = (row: ActionRow) => {
    const action = row.action;
    if (row.kind === "action" && !page && asksMore(action) && !action.unavailable) {
      setPage(action);
      setQuery("");
      setActive(0);
      setProblem(null);
      return;
    }
    const given = rowInput(row);
    if ("problem" in given) {
      setProblem(given.problem);
      return;
    }
    const trigger = opener.current?.isConnected ? opener.current : null;
    onClose();
    rememberAction(action.id);
    void Promise.resolve(action.run({ ...given, trigger })).then(
      (said) => {
        if (typeof said === "string" && said) showToast({ title: said, tone: "danger" });
      },
      () => showToast({ title: "That didn't work. Try again.", tone: "danger" }),
    );
  };
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Backspace" && page && !query) {
      event.preventDefault();
      back();
      return;
    }
    if (!rows.rows.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((at + (event.key === "ArrowDown" ? 1 : rows.rows.length - 1)) % rows.rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows.rows[at];
      if (row) run(row);
    }
  };
  const shortcutQuery = query.trim().toLowerCase();
  const shortcuts = SHORTCUTS.map((group) => ({
    ...group,
    rows: group.rows.filter((row) => row.label.toLowerCase().includes(shortcutQuery)),
  })).filter((group) => group.rows.length);
  const title = page === "shortcuts" ? "Keyboard shortcuts" : (live?.title ?? "Search actions");

  return (
    <LayerPortal kind="dialog" closing={closing} rootRef={root}>
      <div className="ui-scrim" aria-hidden="true" {...scrim} />
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        inert={closing}
        className="ui-picker-popover command-palette"
      >
        <h2 id={titleId} className="ui-visually-hidden">
          {title}
        </h2>
        {page && (
          <div className="command-palette-page">
            <Button variant="quiet" size="sm" icon="chevron-left" onClick={back}>
              All actions
            </Button>
            <span aria-hidden="true">{title}</span>
          </div>
        )}
        <TextField
          ref={field}
          size="sm"
          filled
          className="command-palette-search"
          prefix={<Icon name="search" size={16} />}
          placeholder={
            page === "shortcuts"
              ? "Search shortcuts"
              : (live?.placeholder ??
                (live ? `Search ${live.title.toLowerCase()}` : "Search actions"))
          }
          aria-label={title}
          role={page === "shortcuts" ? undefined : "combobox"}
          aria-expanded={page === "shortcuts" ? undefined : rows.rows.length > 0}
          aria-controls={page === "shortcuts" || !rows.rows.length ? undefined : listId}
          aria-activedescendant={at >= 0 ? rowId(listId, at) : undefined}
          aria-autocomplete={page === "shortcuts" ? undefined : "list"}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActive(0);
            setProblem(null);
          }}
          onKeyDown={key}
        />
        {page === "shortcuts" ? (
          <div className="shortcut-list">
            {shortcuts.map((group) => (
              <section key={group.title} className="shortcut-group" aria-label={group.title}>
                <h3 className="shortcut-group-title">{group.title}</h3>
                {group.rows.map((row) => (
                  <div key={row.label} className="shortcut-row">
                    <span>{row.label}</span>
                    <span className="shortcut-keys">
                      {row.keys.map((keys) => (
                        <Kbd key={keys.join("+")} keys={keys} />
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            ))}
          </div>
        ) : rows.rows.length ? (
          <ActionList
            id={listId}
            label={title}
            rows={rows.shown}
            active={at}
            onActive={setActive}
            onPick={(index) => {
              const row = rows.rows[index];
              if (row) run(row);
            }}
          />
        ) : (
          <p className="command-palette-empty" role="status">
            {live && typeof live.choices === "function" && !loaded.has(live.id)
              ? "Loading…"
              : live?.input && !query.trim()
                ? (live.description ?? "")
                : "Nothing matches."}
          </p>
        )}
        {problem && (
          <p className="command-menu-empty" role="alert">
            {problem}
          </p>
        )}
        <div className="command-palette-foot" aria-hidden="true">
          {page !== "shortcuts" && (
            <>
              <span>
                <Kbd keys={["ArrowUp"]} />
                <Kbd keys={["ArrowDown"]} /> choose
              </span>
              <span>
                <Kbd keys={["Enter"]} /> run
              </span>
            </>
          )}
          <span>
            <Kbd keys={["Escape"]} /> {page ? "back" : "close"}
          </span>
        </div>
      </section>
    </LayerPortal>
  );
}
