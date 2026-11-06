import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Disclosure } from "../ui/Disclosure.tsx";
import { afterMotion } from "../ui/finished.ts";
import { type GlyphState, StatusGlyph } from "../ui/StatusGlyph.tsx";
import { markdownToPlain } from "./markdown.ts";
import type { PlanPhase } from "./plan-state.ts";

export interface PlanItem {
  readonly id: string;
  readonly text: string;
  readonly status: string;
}

const STATES: Record<string, [GlyphState, string]> = {
  todo: ["todo", "Next"],
  doing: ["doing", "In progress"],
  done: ["done", "Done"],
  skipped: ["skipped", "Skipped"],
};
const PHASE_LABEL: Record<PlanPhase, string> = {
  working: "",
  waiting: "Waiting for you",
  paused: "Paused",
  finished: "Finished",
  stopped: "Stopped",
  blocked: "Blocked",
  error: "Interrupted",
};
function stateOf(status: string, phase: PlanPhase): [GlyphState, string] {
  if (phase !== "working" && (status === "doing" || status === "todo")) {
    if (phase === "waiting") return ["ask", "Waiting for you"];
    if (phase === "paused") return ["todo", "Paused"];
    return ["todo", "Not marked complete"];
  }
  return STATES[status] ?? ["todo", "Next"];
}

// What the open list keeps clear of under it, and the least of it that shows on the shortest screen.
const ROOM_BELOW = 8;
const MIN_ROOM = 96;

// How far dot is, and the item it is on, or else the first it has yet to start.
export function planProgress(plan: readonly PlanItem[]): {
  done: number;
  total: number;
  current?: PlanItem;
} {
  const current =
    plan.find((item) => item.status === "doing") ?? plan.find((item) => item.status === "todo");
  return {
    done: plan.filter((item) => item.status === "done").length,
    total: plan.length,
    ...(current ? { current } : {}),
  };
}

// The plan over the steps, as one line: the item dot is on and how far it has got. Open, the whole
// list hangs under that line on the same card, over the steps, which never move. It lives with the
// steps alone: other tabs say how far dot is on the Steps tab itself.
export function PlanStrip({
  plan,
  label = "Task plan",
  phase = "working",
  over,
}: {
  plan: readonly PlanItem[];
  label?: string;
  phase?: PlanPhase;
  // The scrolling list the open card lies over.
  over?: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  // Until the list has folded away again, the card stays lifted over the steps at its closed
  // height, so closing moves them no more than opening does.
  const [lifted, setLifted] = useState(false);
  if (open && !lifted) setLifted(true);
  const [closedHeight, setClosedHeight] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const { done, total, current } = planProgress(plan);
  const shown = current && stateOf(current.status, phase);
  const words = PHASE_LABEL[phase];
  const line = current && markdownToPlain(current.text);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!card.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open]);
  useEffect(() => {
    if (open || !lifted) return;
    return afterMotion([card.current], () => setLifted(false));
  }, [open, lifted]);
  // iOS Safari can draw a scrolling list in a layer of its own, over a card stacked above it, so its
  // rows show through however solid the card is. The part under the card is cut out of the list
  // instead, in the same frame as the card grows. The card's own list stops where the steps' does,
  // so a long plan scrolls rather than running out of the panel.
  useLayoutEffect(() => {
    const list = over?.current;
    const held = card.current;
    const strip = held?.firstElementChild;
    if (!lifted || !list || !held || !strip || typeof ResizeObserver === "undefined") return;
    const cut = () => {
      const under = strip.getBoundingClientRect().bottom - list.getBoundingClientRect().top;
      list.style.clipPath = under > 0 ? `inset(${under}px 0 0)` : "";
    };
    const fit = () => {
      const top = strip.querySelector(".ui-collapse")?.getBoundingClientRect().top ?? 0;
      const room = list.getBoundingClientRect().bottom - top - ROOM_BELOW;
      held.style.setProperty("--_room", `${Math.max(MIN_ROOM, room)}px`);
    };
    cut();
    fit();
    // The height the list is given changes what is observed, so not within the observer's delivery.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cut();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(strip);
    observer.observe(list);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      list.style.clipPath = "";
      held.style.removeProperty("--_room");
    };
  }, [lifted, over]);
  return (
    <div
      ref={card}
      className="plan-card"
      data-lifted={lifted || undefined}
      style={lifted ? ({ "--_closed": `${closedHeight}px` } as CSSProperties) : undefined}
    >
      <Disclosure
        strip
        className="plan-strip"
        open={open}
        onOpenChange={(next) => {
          if (next && !lifted) setClosedHeight(card.current?.getBoundingClientRect().height ?? 0);
          setOpen(next);
        }}
        summary={
          <span className="plan-strip-summary">
            <span className="ui-visually-hidden">Plan: </span>
            {open || !line || !shown ? (
              <span className="plan-strip-title">Plan{words && ` · ${words}`}</span>
            ) : (
              <>
                <StatusGlyph state={shown[0]} label={shown[1]} />
                <span className="plan-strip-text" title={line}>
                  {words && `${words} · `}
                  {line}
                </span>
              </>
            )}
            <span className="plan-strip-count num">
              {done} of {total}
            </span>
            <span
              className="plan-strip-bar"
              aria-hidden="true"
              style={{ "--_done": total ? done / total : 0 } as CSSProperties}
            />
          </span>
        }
      >
        <ol className="plan-list" aria-label={label}>
          {plan.map((item) => {
            const [state, word] = stateOf(item.status, phase);
            const text = markdownToPlain(item.text);
            return (
              <li key={item.id} className="plan-item" data-state={state}>
                <StatusGlyph state={state} label={word} />
                <span className="plan-text">{text}</span>
              </li>
            );
          })}
        </ol>
      </Disclosure>
    </div>
  );
}
