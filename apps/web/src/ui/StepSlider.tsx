import { clsx } from "clsx";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { announce } from "./Announcer.tsx";
import { joinIds } from "./merge.ts";
import { useTooltip } from "./Tooltip.tsx";

type Tone = "used" | "held" | "kept";

// Something the track shows between two values: what is in use, what others hold, what stays free.
export interface SliderMark {
  from: number;
  to: number;
  tone: Tone;
}

// A line of the legend under the track, with a swatch of the mark it names.
export function SliderKey({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="ui-step-slider-key" data-tone={tone}>
      {children}
    </span>
  );
}

export interface StepSliderProps {
  label: string;
  value: number;
  // What can be chosen; the track runs from 0 to its end, which may lie beyond.
  min: number;
  max: number;
  end: number;
  step: number;
  valueText(value: number): string;
  onValueChange(value: number): void;
  marks?: readonly SliderMark[];
  // The end of the track as words, and why it ends there, on hover, focus or a press.
  endLabel: string;
  endTip: string;
  // Why the value stops at min or max, shown once a drag or a key tries to go past it.
  lowReason?: string;
  highReason?: string;
  // Under the track: what its marks mean.
  children?: ReactNode;
  className?: string;
}

const MAX_TICKS = 16;
const exact = (value: number) => Math.round(value * 1e6) / 1e6;

// One cut in the track per whole step, coarser until at most 16 fit.
function tickEvery(end: number, step: number): number {
  let every = Math.max(1, step);
  while (end / every > MAX_TICKS) every *= 2;
  return every;
}

// A native range keeps dragging, a press on the track, touch and assistive technology on one
// value; the keys are taken here so every engine steps alike and stops where the user may go.
export function StepSlider({
  label,
  value,
  min,
  max,
  end,
  step,
  valueText,
  onValueChange,
  marks = [],
  endLabel,
  endTip,
  lowReason,
  highReason,
  children,
  className,
}: StepSliderProps) {
  const id = useId();
  const [pushed, setPushed] = useState<"low" | "high" | null>(null);
  // A value already outside what may be chosen stays where it is until moved inwards.
  const bottom = Math.min(min, value);
  const top = Math.max(min, max, value);
  const at = (amount: number) => Math.min(1, Math.max(0, amount / end));
  const every = tickEvery(end, step);
  const ticks = Array.from({ length: Math.floor(end / every) }, (_, i) => (i + 1) * every).filter(
    (tick) => tick < end,
  );
  const { triggerProps, tooltip } = useTooltip({
    content: endTip,
    description: endTip,
    showOnPress: true,
    align: "end",
  });

  const go = (wanted: number) => {
    const next = exact(Math.min(top, Math.max(bottom, Math.round(wanted / step) * step)));
    const side = wanted > top ? "high" : wanted < bottom ? "low" : null;
    const why = side === "high" ? highReason : side === "low" ? lowReason : undefined;
    if (why && side !== pushed) announce(`slider-${id}`, why);
    setPushed(side);
    if (next !== value) onValueChange(next);
  };
  const big = Math.max(step, every);
  const keys: Record<string, () => number> = {
    ArrowRight: () => value + step,
    ArrowUp: () => value + step,
    ArrowLeft: () => value - step,
    ArrowDown: () => value - step,
    PageUp: () => value + big,
    PageDown: () => value - big,
    // Past the ends, so pressing them where the value already is still says why it stops there.
    Home: () => (value === bottom ? bottom - step : min),
    End: () => (value === top ? top + step : top),
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const key = keys[event.key];
    if (!key || event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    go(key());
  };
  const reason = pushed === "high" ? highReason : pushed === "low" ? lowReason : undefined;

  return (
    <div
      className={clsx("ui-step-slider", className)}
      style={{ "--_value": at(value) } as CSSProperties}
    >
      <div className="ui-step-slider-head">
        <label htmlFor={id} className="ui-step-slider-label">
          {label}
        </label>
        <span className="ui-step-slider-value" aria-hidden="true">
          {valueText(value)}
        </span>
      </div>
      <div className="ui-step-slider-track">
        <div className="ui-step-slider-rail" aria-hidden="true">
          <span className="ui-step-slider-fill" />
          {marks.map((mark) => (
            <span
              key={`${mark.tone}-${mark.from}`}
              className="ui-step-slider-mark"
              data-tone={mark.tone}
              data-start={mark.from <= 0 ? "" : undefined}
              data-end={mark.to >= end ? "" : undefined}
              style={{ "--_from": at(mark.from), "--_to": at(mark.to) } as CSSProperties}
            />
          ))}
          {ticks.map((tick) => (
            <span
              key={tick}
              className="ui-step-slider-tick"
              style={{ "--_at": at(tick) } as CSSProperties}
            />
          ))}
        </div>
        <input
          id={id}
          className="ui-step-slider-input"
          type="range"
          min={0}
          max={end}
          step={step}
          value={value}
          aria-valuetext={valueText(value)}
          aria-describedby={joinIds(`${id}-legend`, reason ? `${id}-reason` : undefined)}
          onKeyDown={onKeyDown}
          onChange={(event) => go(Number(event.target.value))}
          onBlur={() => setPushed(null)}
        />
      </div>
      <div className="ui-step-slider-foot">
        <span id={`${id}-legend`} className="ui-step-slider-legend">
          {children}
        </span>
        <button
          {...triggerProps.handlers}
          type="button"
          className="ui-step-slider-end"
          aria-label={`${label} limit: ${endLabel}`}
          aria-describedby={triggerProps["aria-describedby"]}
        >
          {endLabel}
        </button>
        {tooltip}
      </div>
      <p id={`${id}-reason`} className="ui-step-slider-reason">
        {reason}
      </p>
    </div>
  );
}
