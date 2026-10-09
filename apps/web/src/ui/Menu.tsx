import { clsx } from "clsx";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useId,
  useRef,
} from "react";
import { focusWithoutScroll } from "./focus.ts";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";
import { formatKeys } from "./Kbd.tsx";
import { lastModality } from "./LayerStack.tsx";
import { Anchored } from "./Popover.tsx";
import type { Align, Side } from "./position.ts";
import { pressHandlers } from "./press.ts";

// Typed letters within this long of each other search together.
const TYPEAHEAD = 500;

interface MenuState {
  anchor: RefObject<HTMLElement | null>;
  close(): void;
}

const MenuContext = createContext<MenuState | null>(null);

function items(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")];
}

export interface MenuProps {
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  side?: Side;
  align?: Align;
  // Dims the page behind it.
  dim?: boolean;
  className?: string;
  children: ReactNode;
}

// Opened from the keyboard it lands on the first item; opened by a press it waits for the pointer
// or an arrow key, the way a desktop menu does.
export function Menu({ label, className, children, ...props }: MenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", at: 0 });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menu = panel.current;
    if (!menu) return;
    const list = items(menu);
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (index: number) => {
      const item = list.at(index % list.length);
      if (item) focusWithoutScroll(item);
    };
    switch (event.key) {
      case "ArrowDown":
        go(at + 1);
        break;
      case "ArrowUp":
        go(at < 0 ? -1 : at - 1 + list.length);
        break;
      case "Home":
      case "PageUp":
        go(0);
        break;
      case "End":
      case "PageDown":
        go(-1);
        break;
      case "Tab":
        props.onClose();
        break;
      case " ":
      case "Enter":
        return;
      default: {
        if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
        const now = performance.now();
        const typed = now - search.current.at < TYPEAHEAD ? search.current.text : "";
        const text = typed + event.key.toLowerCase();
        search.current = { text, at: now };
        // The same letter again moves on to the next item that starts with it; a longer word stays
        // on the current item while it still matches.
        const repeat = text.length > 1 && [...text].every((letter) => letter === text[0]);
        const query = repeat ? text.charAt(0) : text;
        const from = text.length === 1 || repeat ? at + 1 : Math.max(at, 0);
        const match = [...list.slice(from), ...list.slice(0, from)].find((item) =>
          item.dataset.label?.toLowerCase().startsWith(query),
        );
        if (match) focusWithoutScroll(match);
      }
    }
    event.preventDefault();
  };

  return (
    <MenuContext.Provider value={{ anchor: props.anchor, close: props.onClose }}>
      <Anchored
        {...props}
        kind="menu"
        trap={false}
        panelRef={panel}
        initialFocus={(menu) => (lastModality() === "keyboard" ? items(menu)[0] : undefined)}
        panelProps={{
          role: "menu",
          "aria-label": label,
          className: clsx("ui-menu", className),
          onKeyDown,
          onPointerLeave: (event) => {
            if (event.pointerType !== "touch") focusWithoutScroll(event.currentTarget);
          },
        }}
      >
        {children}
      </Anchored>
    </MenuContext.Provider>
  );
}

export interface MenuItemProps {
  onSelect(): void;
  icon?: IconName;
  kbd?: readonly string[];
  // Unavailable while set: the item stays reachable and says why under its label.
  disabledReason?: string;
  // The text typeahead matches, when the label is not plain text.
  textValue?: string;
  children: ReactNode;
}

export function MenuItem({
  onSelect,
  icon,
  kbd,
  disabledReason,
  textValue,
  children,
}: MenuItemProps) {
  const menu = useContext(MenuContext);
  const labelId = useId();
  const reasonId = useId();
  const keys = kbd && formatKeys(kbd);
  return (
    <button
      {...pressHandlers}
      type="button"
      role="menuitem"
      tabIndex={-1}
      className="ui-menu-item"
      data-label={textValue ?? (typeof children === "string" ? children : undefined)}
      aria-labelledby={labelId}
      aria-disabled={disabledReason ? true : undefined}
      aria-describedby={disabledReason ? reasonId : undefined}
      aria-keyshortcuts={keys?.aria}
      onPointerMove={(event) => {
        if (event.pointerType !== "touch" && document.activeElement !== event.currentTarget)
          focusWithoutScroll(event.currentTarget);
      }}
      onClick={() => {
        if (disabledReason || !menu) return;
        // Focus is back on the trigger before the action runs, so anything it opens returns there.
        const anchor = menu.anchor.current;
        if (anchor) focusWithoutScroll(anchor);
        menu.close();
        onSelect();
      }}
    >
      {icon && <Icon name={icon} size={18} className="ui-menu-icon" />}
      <span className="ui-menu-text">
        <span id={labelId} className="ui-menu-label">
          {children}
        </span>
        {disabledReason && (
          <span id={reasonId} className="ui-menu-reason">
            {disabledReason}
          </span>
        )}
      </span>
      {keys && (
        <span className="ui-menu-kbd" aria-hidden="true">
          {keys.label}
        </span>
      )}
    </button>
  );
}

export function MenuSeparator() {
  return <hr className="ui-menu-separator" />;
}

export function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a menu groups its items with role group, not a fieldset.
    <div role="group" aria-labelledby={id}>
      <div id={id} className="ui-menu-group-label">
        {label}
      </div>
      {children}
    </div>
  );
}
