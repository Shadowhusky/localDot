import { clsx } from "clsx";

const HIGH = 0.9;

export interface MeterProps {
  value: number;
  max?: number;
  label: string;
  className?: string;
}

export function Meter({ value, max = 100, label, className }: MeterProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    // biome-ignore lint/a11y/useSemanticElements: A native meter draws differently in each engine and can't take the kit's track.
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={clsx("ui-meter", className)}
      data-high={ratio >= HIGH || undefined}
    >
      <span className="ui-meter-fill" style={{ scale: `${ratio} 1` }} />
    </div>
  );
}
