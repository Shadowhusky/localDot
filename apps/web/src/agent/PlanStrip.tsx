import { type CSSProperties, useState } from "react";
import { Disclosure } from "../ui/Disclosure.tsx";
import { type GlyphState, StatusGlyph } from "../ui/StatusGlyph.tsx";
import { markdownToPlain } from "./markdown.ts";

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
const stateOf = (status: string): [GlyphState, string] => STATES[status] ?? ["todo", "Next"];

// The item dot is on, or else the first it has yet to start, and the one it starts after that.
export function planFocus(plan: readonly PlanItem[]): { current?: PlanItem; next?: PlanItem } {
  const doing = plan.findIndex((item) => item.status === "doing");
  const at = doing >= 0 ? doing : plan.findIndex((item) => item.status === "todo");
  if (at < 0) return {};
  return { current: plan[at], next: plan.slice(at + 1).find((item) => item.status === "todo") };
}

function FocusLine({ item, next = false }: { item: PlanItem; next?: boolean }) {
  const [state, word] = stateOf(item.status);
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

// The plan as one compact strip: how far dot is, the item it is on and the next. The whole list
// unfolds in place under it.
export function PlanStrip({
  plan,
  label = "Task plan",
}: {
  plan: readonly PlanItem[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const done = plan.filter((item) => item.status === "done").length;
  const { current, next } = planFocus(plan);
  return (
    <Disclosure
      strip
      className="plan-strip"
      open={open}
      onOpenChange={setOpen}
      summary={
        <span className="plan-strip-summary">
          <span className="plan-strip-head">
            <span className="plan-strip-title">Plan</span>
            <span
              className="plan-strip-bar"
              aria-hidden="true"
              style={{ "--_done": plan.length ? done / plan.length : 0 } as CSSProperties}
            />
            <span className="plan-strip-count num">
              {done} of {plan.length}
            </span>
          </span>
          {!open && current && <FocusLine item={current} />}
          {!open && next && <FocusLine item={next} next />}
        </span>
      }
    >
      <ol className="plan-list" aria-label={label}>
        {plan.map((item) => {
          const [state, word] = stateOf(item.status);
          const text = markdownToPlain(item.text);
          return (
            <li key={item.id} className="plan-item" data-state={item.status}>
              <StatusGlyph state={state} label={word} />
              <span className="plan-text">{text}</span>
            </li>
          );
        })}
      </ol>
    </Disclosure>
  );
}
