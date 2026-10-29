import { clsx } from "clsx";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
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
  // A quiet number after the label, such as how many files a tab holds.
  count?: number;
  // An amber point at the segment's corner, such as Chat while dot asks and Activity shows.
  attention?: boolean;
  // A quiet point after the label for something the user has not seen yet, such as a new file.
  fresh?: boolean;
}

export interface SegmentTrackProps {
  items: readonly SegmentItem[];
  value: string;
  onValueChange(value: string): void;
  // The chosen segment pressed again, such as Replay while a recording plays, to go back to its list.
  onReselect?(value: string): void;
  // Track height in px: 32 for a rail's header, 28 for Watch | Replay and filters, 24 inside a list.
  size?: 24 | 28 | 32;
  // Let the segments fit a constrained container instead of reserving their usual minimum width.
  compact?: boolean;
  // Line: tabs over a hairline, each as wide as its name, the chosen one underlined; when the names
  // don't all fit, tabs that all have icons show those instead. Quiet: no track, a soft thumb.
  variant?: "line" | "quiet";
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
  iconic,
  extra,
  onSelect,
}: {
  item: SegmentItem;
  focusable: boolean;
  // Shown by its icon alone, its name kept for assistive technology and as its tooltip.
  iconic: boolean;
  extra: Record<string, string | boolean | undefined>;
  onSelect(event: MouseEvent<HTMLButtonElement>): void;
}) {
  const { triggerProps, tooltip } = useTooltip({
    content: item.disabledReason ?? (iconic ? item.label : undefined),
    description: item.disabledReason,
    showOnPress: !!item.disabledReason,
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
        {item.count !== undefined && (
          <>
            {" "}
            <span className="ui-segment-count num">{item.count}</span>
          </>
        )}
        {item.fresh && <span className="ui-segment-fresh" aria-hidden="true" />}
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
  compact,
  variant,
  className,
  "aria-label": label,
  parts,
}: SegmentTrackProps & { parts: TrackParts }): ReactNode {
  const track = useRef<HTMLDivElement>(null);
  const index = items.findIndex((item) => item.value === value);
  const focusIndex = index >= 0 ? index : 0;
  const [iconic, setIconic] = useState(false);
  const line = variant === "line";
  const canIconic = items.every((item) => item.icon);
  const widths = items
    .map((item) => `${item.value}:${item.label}:${item.count ?? ""}:${item.fresh ? 1 : 0}`)
    .join(" ");
  // Line tabs differ in width, so the underline is placed from the chosen tab as laid out. Whether
  // the names fit is measured with them shown, so a tab row that has room again gets them back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `widths` and `iconic` change what sizes a tab.
  useLayoutEffect(() => {
    const node = track.current;
    if (!line || !node) return;
    let frame = 0;
    const measure = () => {
      if (canIconic) {
        node.dataset.measuring = "";
        const labels = node.querySelectorAll<HTMLElement>(".ui-segment-label");
        setIconic([...labels].some((label) => label.scrollWidth > label.clientWidth));
        delete node.dataset.measuring;
      }
      const chosen = node.querySelectorAll<HTMLElement>(".ui-segment")[index];
      node.style.setProperty("--_thumb-x", `${chosen?.offsetLeft ?? 0}px`);
      node.style.setProperty("--_thumb-w", `${chosen?.offsetWidth ?? 0}px`);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(measure);
          });
    observer?.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [line, canIconic, widths, index, iconic]);

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
      data-compact={compact || undefined}
      data-variant={variant}
      data-iconic={(line && canIconic && iconic) || undefined}
      style={{ "--_count": items.length, "--_index": Math.max(index, 0) } as CSSProperties}
    >
      <span className="ui-segmented-thumb" data-hidden={index < 0 ? "" : undefined} />
      {items.map((item, at) => (
        <Segment
          key={item.value}
          item={item}
          focusable={at === focusIndex}
          iconic={line && canIconic && iconic}
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
