import { useEffect, useRef, useState } from "react";
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
  // Measured on scroll and resize rather than observed: a pane that was hidden when an observer
  // started never reports a change once it is shown. In a phone's sheet the sheet's body scrolls
  // the plan rather than the rail's own scroller.
  useEffect(() => {
    const mark = sentinel.current;
    const roots = [mark?.closest(".ui-scroll-area"), mark?.closest(".ui-sheet-body")].filter(
      (root): root is HTMLElement => root instanceof HTMLElement,
    );
    if (!mark || !roots.length) return;
    const scroller = () =>
      roots.find((root) => root.scrollHeight > root.clientHeight + 1) ?? (roots[0] as HTMLElement);
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const root = scroller();
        const top = root.getBoundingClientRect().top + (head.current?.offsetHeight ?? 0);
        setStuck(root.clientHeight > 0 && mark.getBoundingClientRect().top < top);
      });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const root of roots) {
      root.addEventListener("scroll", measure, { passive: true });
      observer?.observe(root);
    }
    return () => {
      cancelAnimationFrame(frame);
      for (const root of roots) root.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);
  return (
    <>
      <div ref={head} className="plan-head" data-stuck={stuck || undefined}>
        <h3 className="plan-title">Plan</h3>
        <span className="plan-progress" aria-hidden="true">
          {plan.map((item) => (
            <span key={item.id} data-state={item.status} />
          ))}
        </span>
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
              <span className="plan-text">{markdownToPlain(item.text)}</span>
            </li>
          );
        })}
      </ol>
      <span ref={sentinel} className="plan-sentinel" aria-hidden="true" />
    </>
  );
}
