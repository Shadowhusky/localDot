import { clsx } from "clsx";
import { type CSSProperties, type KeyboardEvent, useRef } from "react";
import { pressHandlers } from "./press.ts";

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  items: readonly SegmentedItem<NoInfer<T>>[];
  value: T;
  onChange(value: NoInfer<T>): void;
  label: string;
  size?: 24 | 28;
  className?: string;
}

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

// A radio group: arrows move the choice and focus together, and only the chosen segment is a tab stop.
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  label,
  size = 28,
  className,
}: SegmentedControlProps<T>) {
  const group = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    items.findIndex((item) => item.value === value),
  );
  const choose = (next: number) => {
    const item = items[(next + items.length) % items.length];
    if (!item) return;
    onChange(item.value);
    group.current
      ?.querySelectorAll<HTMLButtonElement>("[role=radio]")
      [(next + items.length) % items.length]?.focus();
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      className={clsx("ui-segmented", className)}
      data-size={size}
      style={{ "--_count": items.length, "--_index": index } as CSSProperties}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        const step = STEP[event.key];
        if (step !== undefined) choose(index + step);
        else if (event.key === "Home") choose(0);
        else if (event.key === "End") choose(items.length - 1);
        else return;
        event.preventDefault();
      }}
    >
      <span className="ui-segmented-thumb" aria-hidden="true" />
      {items.map((item) => {
        const checked = item.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: Segments are buttons in a radio group so one shared thumb can slide between them.
          <button
            key={item.value}
            {...pressHandlers}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="ui-segmented-item"
            onClick={() => onChange(item.value)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
