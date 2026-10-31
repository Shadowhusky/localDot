import { clsx } from "clsx";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";
import { attachLongPress } from "./long-press.ts";
import { matches, REDUCED_MOTION } from "./media.ts";
import { attachSwipe, type Swipe, type SwipeSide } from "./row-swipe.ts";
import "./swipe.css";

// One face's width; a long swipe takes the row on past them all.
const FACE = 76;

export interface SwipeAction {
  label: string;
  icon: IconName;
  onAction(): void;
  // Carrying it out takes the row out of its list, so the row slides away first.
  leaves?: boolean;
}

export interface SwipeActionsProps {
  // Shown by a swipe right; a long swipe right carries it out.
  leading?: SwipeAction;
  // Shown by a swipe left, the first at the edge; a long swipe left carries out the first.
  trailing?: readonly SwipeAction[];
  // A finger held still on the row, or a right click on it.
  onHold?(): void;
  className?: string;
  children: ReactNode;
}

// The action a long swipe toward `side` carries out.
const firstOn = (
  actions: { leading?: SwipeAction; trailing: readonly SwipeAction[] },
  side: SwipeSide,
) => (side === "leading" ? actions.leading : actions.trailing[0]);

// A row a finger slides aside to show what can be done to it, as Messages' and Mail's do. A long
// swipe crosses a line where the first action fills the row and its glyph ticks, in place of the
// tap iOS gives, and letting go there carries it out. The faces are for touch only: they are
// hidden from assistive technology and the keyboard, so every action must also be in the row's menu.
export function SwipeActions({
  leading,
  trailing = [],
  onHold,
  className,
  children,
}: SwipeActionsProps) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const swipe = useRef<Swipe | null>(null);
  const [armed, setArmed] = useState(false);
  const [holding, setHolding] = useState(false);
  const actions = useRef({ leading, trailing, onHold });
  actions.current = { leading, trailing, onHold };
  const leadingWidth = leading ? FACE : 0;
  const trailingWidth = trailing.length * FACE;
  const holds = !!onHold;

  useEffect(() => {
    const element = content.current;
    const outer = box.current;
    if (!element || !outer) return;
    const attached = attachSwipe(
      element,
      {
        rest: () => {},
        reducedMotion: () => matches(REDUCED_MOTION),
        moved: (offset) => {
          outer.style.setProperty("--_offset", `${offset}px`);
          if (!offset) delete outer.dataset.moved;
          else if (outer.dataset.moved === undefined) {
            outer.dataset.moved = "";
            // A row that slides is not being pressed: its button lets go of its light.
            for (const pressed of outer.querySelectorAll<HTMLElement>("[data-pressed]"))
              delete pressed.dataset.pressed;
          }
        },
        armed: setArmed,
        leaves: (side) => !!firstOn(actions.current, side)?.leaves,
        commit: (side) => firstOn(actions.current, side)?.onAction(),
      },
      {
        leading: leadingWidth,
        trailing: trailingWidth,
        commits: ["leading", "trailing"],
      },
    );
    swipe.current = attached;
    const letGo = holds
      ? attachLongPress(element, {
          pressing: setHolding,
          hold: () => {
            attached.cancel();
            attached.close();
            actions.current.onHold?.();
          },
        })
      : undefined;
    return () => {
      swipe.current = null;
      attached.detach();
      letGo?.();
    };
  }, [leadingWidth, trailingWidth, holds]);

  const run = (side: SwipeSide, action: SwipeAction) => {
    if (action.leaves) swipe.current?.away(side, action.onAction);
    else {
      swipe.current?.close();
      action.onAction();
    }
  };

  const face = (side: SwipeSide, action: SwipeAction, primary: boolean) => (
    <button
      key={action.label}
      type="button"
      tabIndex={-1}
      className="ui-swipe-face"
      data-primary={primary || undefined}
      onClick={() => run(side, action)}
    >
      <span className="ui-swipe-face-inner">
        <Icon name={action.icon} size={18} />
        <span className="ui-swipe-label">{action.label}</span>
      </span>
    </button>
  );

  return (
    <div
      ref={box}
      className={clsx("ui-swipe", className)}
      data-armed={armed || undefined}
      data-holding={holding || undefined}
    >
      {leading && (
        <div className="ui-swipe-faces" data-side="leading" aria-hidden="true">
          {face("leading", leading, true)}
        </div>
      )}
      {trailing.length > 0 && (
        <div className="ui-swipe-faces" data-side="trailing" aria-hidden="true">
          {trailing.map((action, index) => face("trailing", action, index === 0)).reverse()}
        </div>
      )}
      <div ref={content} className="ui-swipe-content">
        {children}
      </div>
    </div>
  );
}
