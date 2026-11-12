import { clsx } from "clsx";
import { type CSSProperties, useId } from "react";
import { t } from "../i18n/index.ts";

// From this share of the limit the fill brightens and says so in words, never by colour alone.
export const NEAR_LIMIT = 0.9;

export interface MeterProps {
  label: string;
  value: number;
  max?: number;
  // What the value means, shown at the right: "62% used". A percentage when left out.
  valueText?: string;
  className?: string;
}

// How much of a limit is used: a name and an amount over a 4 px bar.
export function Meter({ label, value, max = 100, valueText, className }: MeterProps) {
  const id = useId();
  const used = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const near = used >= NEAR_LIMIT;
  const full = used >= 1;
  const amount = valueText ?? `${Math.round(used * 100)}%`;
  const shown = near
    ? full
      ? t`Limit reached · ${amount}`
      : t`Almost at limit · ${amount}`
    : amount;
  const spoken = full ? t`${amount}, limit reached` : t`${amount}, almost at limit`;
  return (
    <div
      className={clsx("ui-meter", className)}
      data-near={near ? "" : undefined}
      style={{ "--_value": used } as CSSProperties}
    >
      <div className="ui-meter-head">
        <span id={`${id}-label`} className="ui-meter-label">
          {label}
        </span>
        <span className="ui-meter-value" aria-hidden="true">
          {shown}
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a native meter draws differently in each engine and cannot take the kit's bar. */}
      <div
        role="meter"
        aria-labelledby={`${id}-label`}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(max, Math.max(0, value))}
        aria-valuetext={near ? spoken : amount}
        className="ui-meter-track"
      >
        <span className="ui-meter-fill" />
      </div>
    </div>
  );
}
