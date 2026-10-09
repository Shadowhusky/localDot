import { clsx } from "clsx";

export type GlyphState = "todo" | "doing" | "done" | "failed" | "skipped" | "ask";

const LABELS: Record<GlyphState, string> = {
  todo: "Not started",
  doing: "In progress",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  ask: "Needs you",
};

export interface StatusGlyphProps {
  state: GlyphState;
  label?: string;
  className?: string;
}

export function StatusGlyph({ state, label, className }: StatusGlyphProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      role="img"
      aria-label={label ?? LABELS[state]}
      data-state={state}
      className={clsx("ui-status-glyph", className)}
    >
      <circle className="ui-status-ring" cx="8" cy="8" r="6.6" />
      {state === "doing" && (
        <path className="ui-status-arc" d="M8 1.4a6.6 6.6 0 0 1 6.6 6.6" strokeWidth={1.8} />
      )}
      {state === "done" && (
        <path
          className="ui-status-check"
          d="m5.2 8.2 1.9 1.9 3.8-4"
          strokeWidth={1.5}
          pathLength={1}
        />
      )}
      {state === "failed" && <path d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4" strokeWidth={1.4} />}
      {state === "skipped" && <path d="M5.4 8h5.2" strokeWidth={1.4} />}
      {state === "ask" && <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" />}
    </svg>
  );
}
