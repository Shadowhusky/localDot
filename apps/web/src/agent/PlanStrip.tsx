import { type CSSProperties, useEffect, useRef, useState } from "react";
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

// The item dot is on, or else the first it has yet to start, and the one it starts after that.
export function planFocus(plan: readonly PlanItem[]): { current?: PlanItem; next?: PlanItem } {
  const doing = plan.findIndex((item) => item.status === "doing");
  const at = doing >= 0 ? doing : plan.findIndex((item) => item.status === "todo");
  if (at < 0) return {};
  return { current: plan[at], next: plan.slice(at + 1).find((item) => item.status === "todo") };
}

function FocusLine({
  item,
  phase,
  next = false,
}: {
  item: PlanItem;
  phase: PlanPhase;
  next?: boolean;
}) {
  const [state, word] = stateOf(item.status, phase);
  const text = markdownToPlain(item.text);
  return (
    <span className="plan-strip-line" data-next={next || undefined}>
      <StatusGlyph state={state} label={next ? "Then" : word} />
      <span className="plan-strip-text" title={text}>
        {text}
      </span>
    </span>
  );
}

// The plan as one compact card over the steps: how far dot is, the item it is on and the next.
// Open, the whole list takes the place of those two lines on the same card, and the card keeps
// its closed height in the rail so the steps under it never move.
export function PlanStrip({
  plan,
  label = "Task plan",
  phase = "working",
}: {
  plan: readonly PlanItem[];
  label?: string;
  phase?: PlanPhase;
}) {
  const [open, setOpen] = useState(false);
  // Until the list has folded away again, the card stays lifted over the steps at its closed
  // height, so closing moves them no more than opening does.
  const [lifted, setLifted] = useState(false);
  if (open && !lifted) setLifted(true);
  const [closedHeight, setClosedHeight] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const done = plan.filter((item) => item.status === "done").length;
  const { current, next } = planFocus(plan);
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
            <span className="plan-strip-head">
              <span className="plan-strip-title">
                Plan{PHASE_LABEL[phase] && ` · ${PHASE_LABEL[phase]}`}
              </span>
              <span
                className="plan-strip-bar"
                aria-hidden="true"
                style={{ "--_done": plan.length ? done / plan.length : 0 } as CSSProperties}
              />
              <span className="plan-strip-count num">
                {done} of {plan.length}
              </span>
            </span>
            {!open && current && <FocusLine item={current} phase={phase} />}
            {!open && next && phase === "working" && <FocusLine item={next} phase={phase} next />}
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
