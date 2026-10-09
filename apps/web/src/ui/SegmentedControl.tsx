import { clsx } from "clsx";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useRef,
} from "react";
import { useFieldControl } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";
import { mergeHandlers } from "./merge.ts";
import { pressHandlers } from "./press.ts";
import { useTooltip } from "./Tooltip.tsx";

export interface SegmentItem {
  value: string;
  label: string;
  icon?: IconName;
  disabledReason?: string;
  // An amber point at the segment's corner, such as Chat while dot asks and Activity shows.
  attention?: boolean;
}

export interface SegmentTrackProps {
  items: readonly SegmentItem[];
  value: string;
  onValueChange(value: string): void;
  // The chosen segment pressed again, such as Replay while a recording plays, to go back to its list.
  onReselect?(value: string): void;
  // Track height in px: 32 for a rail's header, 28 for Watch | Replay and filters, 24 inside a list.
  size?: 24 | 28 | 32;
  className?: string;
  "aria-label"?: string;
}

interface TrackParts {
  role: "radiogroup" | "tablist";
  id?: string;
  labelledBy?: string;
  describedBy?: string;
  // The props a segment adds for its role: aria-checked for a radio, aria-selected for a tab.
  segment(item: SegmentItem, selected: boolean): Record<string, string | boolean | undefined>;
}

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

function Segment({
  item,
  focusable,
  extra,
  onSelect,
}: {
  item: SegmentItem;
  focusable: boolean;
  extra: Record<string, string | boolean | undefined>;
  onSelect(event: MouseEvent<HTMLButtonElement>): void;
}) {
  const { triggerProps, tooltip } = useTooltip({
    content: item.disabledReason,
    description: item.disabledReason,
    showOnPress: true,
  });
  return (
    <>
      <button
        {...mergeHandlers({}, pressHandlers, triggerProps.handlers)}
        {...extra}
        type="button"
        className="ui-segment"
        tabIndex={focusable ? 0 : -1}
        data-value={item.value}
        aria-disabled={item.disabledReason ? true : undefined}
        aria-describedby={triggerProps["aria-describedby"]}
        onClick={onSelect}
      >
        {item.icon && <Icon name={item.icon} />}
        <span className="ui-segment-label">{item.label}</span>
        {item.attention && <span className="ui-segment-attention" aria-hidden="true" />}
      </button>
      {tooltip}
    </>
  );
}

// The track and sliding thumb a segmented control and tabs share; they differ only in roles.
export function SegmentTrack({
  items,
  value,
  onValueChange,
  onReselect,
  size = 28,
  className,
  "aria-label": label,
  parts,
}: SegmentTrackProps & { parts: TrackParts }): ReactNode {
  const track = useRef<HTMLDivElement>(null);
  const index = items.findIndex((item) => item.value === value);
  const focusIndex = index >= 0 ? index : 0;

  const select = (item: SegmentItem) => {
    if (item.disabledReason) return;
    if (item.value !== value) onValueChange(item.value);
    else onReselect?.(item.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = items.findIndex(
      (item) => item.value === (event.target as HTMLElement).dataset.value,
    );
    if (from < 0) return;
    let to: number | undefined;
    if (event.key in NEXT) {
      const step = NEXT[event.key] as number;
      for (let i = 1; i <= items.length; i++) {
        const at = (from + step * i + items.length * i) % items.length;
        if (!items[at]?.disabledReason) {
          to = at;
          break;
        }
      }
    } else if (event.key === "Home") to = items.findIndex((item) => !item.disabledReason);
    else if (event.key === "End") to = items.findLastIndex((item) => !item.disabledReason);
    const target = to === undefined ? undefined : items[to];
    if (!target || to === undefined) return;
    event.preventDefault();
    track.current?.querySelectorAll<HTMLButtonElement>(".ui-segment")[to]?.focus();
    select(target);
  };

  // A radio group or a tab list: either names itself and takes the arrow keys.
  const group = {
    role: parts.role,
    "aria-label": label,
    "aria-labelledby": label ? undefined : parts.labelledBy,
    "aria-describedby": parts.describedBy,
    onKeyDown,
  };

  return (
    <div
      ref={track}
      {...group}
      id={parts.id}
      className={clsx("ui-segmented", className)}
      data-size={size}
      style={{ "--_count": items.length, "--_index": Math.max(index, 0) } as CSSProperties}
    >
      <span className="ui-segmented-thumb" data-hidden={index < 0 ? "" : undefined} />
      {items.map((item, at) => (
        <Segment
          key={item.value}
          item={item}
          focusable={at === focusIndex}
          extra={parts.segment(item, at === index)}
          onSelect={() => select(item)}
        />
      ))}
    </div>
  );
}

export function SegmentedControl(props: SegmentTrackProps) {
  const control = useFieldControl({});
  return (
    <SegmentTrack
      {...props}
      parts={{
        role: "radiogroup",
        id: control.id,
        labelledBy: control.labelId,
        describedBy: control.describedBy,
        segment: (_, selected) => ({ role: "radio", "aria-checked": selected }),
      }}
    />
  );
}
