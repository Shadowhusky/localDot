import { clsx } from "clsx";

export type GlyphState = "todo" | "doing" | "done" | "failed" | "skipped";

const LABELS: Record<GlyphState, string> = {
  todo: "Not started",
  doing: "In progress",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
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
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      role="img"
      aria-label={label ?? LABELS[state]}
      data-state={state}
      className={clsx("ui-status-glyph", className)}
    >
      <circle className="ui-status-ring" cx="8" cy="8" r="6.25" />
      {state === "doing" && (
        <path className="ui-status-arc" d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" />
      )}
      {state === "done" && (
        <path className="ui-status-check" d="M5.25 8.25 7.1 10.1l3.65-3.85" pathLength={1} />
      )}
      {state === "failed" && <path d="m6 6 4 4m0-4-4 4" />}
      {state === "skipped" && <path d="M5.5 8h5" />}
    </svg>
  );
}
