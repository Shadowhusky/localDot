import { useEffect, useRef, useState } from "react";
import { type GlyphState, StatusGlyph } from "../ui/StatusGlyph.tsx";

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

// The header sticks to the top of the panel's scroller. Once the list has scrolled under it, it names
// the item in progress, so where dot is in the plan stays in view however long the steps run.
export function PlanView({
  plan,
  label = "Task plan",
}: {
  plan: readonly PlanItem[];
  label?: string;
}) {
  const sentinel = useRef<HTMLSpanElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  const done = plan.filter((item) => item.status === "done").length;
  const current =
    plan.find((item) => item.status === "doing") ?? plan.find((item) => item.status === "todo");
  // Measured on scroll and resize rather than observed: a pane that was hidden when an observer
  // started never reports a change once it is shown.
  useEffect(() => {
    const mark = sentinel.current,
      root = mark?.closest(".ui-scroll-area");
    if (!mark || !root) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = root.getBoundingClientRect().top + (head.current?.offsetHeight ?? 0);
        setStuck(root.clientHeight > 0 && mark.getBoundingClientRect().top < top);
      });
    };
    measure();
    root.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);
  return (
    <>
      <div ref={head} className="plan-head" data-stuck={stuck || undefined}>
        <h3 className="plan-title">
          <span className="plan-title-name">Plan</span>
          <span className="plan-title-current" aria-hidden="true">
            {current && (
              <>
                <StatusGlyph state={stateOf(current.status)[0]} label="" />
                <span>{current.text}</span>
              </>
            )}
          </span>
        </h3>
        <span className="plan-count num">
          <span className="plan-roll">
            <span key={done}>{done}</span>
          </span>{" "}
          of {plan.length} done
        </span>
      </div>
      <ol className="plan-list" aria-label={label}>
        {plan.map((item) => {
          const [state, word] = stateOf(item.status);
          return (
            <li key={item.id} className="plan-item" data-state={item.status}>
              <StatusGlyph state={state} label={word} />
              <span className="plan-text">{item.text}</span>
            </li>
          );
        })}
      </ol>
      <span ref={sentinel} className="plan-sentinel" aria-hidden="true" />
    </>
  );
}
