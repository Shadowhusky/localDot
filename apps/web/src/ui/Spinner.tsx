import { clsx } from "clsx";

const GRID = 16;
const STROKE = 1.5;

export interface SpinnerProps {
  size?: 12 | 14 | 16;
  label?: string;
  className?: string;
}

export function Spinner({ size = 16, label, className }: SpinnerProps) {
  const stroke = (STROKE * GRID) / size;
  return (
    <svg
      viewBox={`0 0 ${GRID} ${GRID}`}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      focusable="false"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={clsx("ui-spinner", className)}
    >
      <circle className="ui-spinner-track" cx="8" cy="8" r="6.25" />
      <path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" />
    </svg>
  );
}
