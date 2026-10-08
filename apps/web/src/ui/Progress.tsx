import { clsx } from "clsx";
import type { CSSProperties } from "react";

const GRID = 24;
// The ring's line is this many pixels at every size.
const RING_STROKE = 2;

export interface ProgressProps {
  label: string;
  // Without a value it shows work under way of unknown length.
  value?: number;
  max?: number;
  // How a screen reader reads the value, when a percentage says less than "12 of 40 files".
  valueText?: string;
  variant?: "bar" | "ring";
  // Ring only.
  size?: 16 | 20 | 24;
  className?: string;
}

function share(value: number, max: number): number {
  return max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
}

export function Progress({
  label,
  value,
  max = 1,
  valueText,
  variant = "bar",
  size = 16,
  className,
}: ProgressProps) {
  const known = value !== undefined;
  const done = known ? share(value, max) : 0;
  const complete = known && done >= 1;
  const common = {
    role: "progressbar",
    "aria-label": label,
    "aria-valuemin": known ? 0 : undefined,
    "aria-valuemax": known ? max : undefined,
    "aria-valuenow": known ? Math.min(max, Math.max(0, value)) : undefined,
    "aria-valuetext": known ? valueText : undefined,
    "data-indeterminate": known ? undefined : "",
    "data-complete": complete ? "" : undefined,
    style: { "--_value": done } as CSSProperties,
  };

  if (variant === "bar") {
    return (
      <div {...common} className={clsx("ui-progress", className)} data-variant="bar">
        <span className="ui-progress-fill" />
      </div>
    );
  }

  const stroke = (RING_STROKE * GRID) / size;
  const radius = (GRID - stroke) / 2;
  return (
    <span {...common} className={clsx("ui-progress", className)} data-variant="ring">
      <svg
        viewBox={`0 0 ${GRID} ${GRID}`}
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        focusable="false"
        aria-hidden="true"
        className="ui-progress-ring"
      >
        <circle className="ui-progress-track" cx="12" cy="12" r={radius} />
        <circle
          className="ui-progress-arc"
          cx="12"
          cy="12"
          r={radius}
          pathLength={1}
          strokeDasharray={known ? "1 1" : "0.25 1"}
        />
        {complete && (
          <path
            className="ui-progress-check"
            d="m8 12.5 2.75 2.75L16 10"
            pathLength={1}
            strokeWidth={stroke * 0.75}
            strokeLinejoin="round"
          />
        )}
      </svg>
    </span>
  );
}
