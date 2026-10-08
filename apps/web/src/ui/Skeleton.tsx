import { clsx } from "clsx";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { afterMotion } from "./finished.ts";

export interface SkeletonProps {
  loading: boolean;
  // A line of text in the surrounding type, a block (a thumbnail, a row) or a circle.
  shape?: "text" | "block" | "circle";
  // How wide the content is expected to be: "16ch" for a name, "100%" for a sentence.
  width?: string;
  // Block and circle only; a text line is one line of the surrounding type tall.
  height?: string;
  // Text only. The last line is shorter, as the end of a paragraph is.
  lines?: number;
  className?: string;
  children?: ReactNode;
}

// Holds the exact room its content will take, so nothing moves when the content arrives. The bones
// show only if loading lasts, then the content fades in over them as they fade out. Loading again,
// the content last shown stays until the bones would show, and then gives way to them.
export function Skeleton({
  loading,
  shape = "text",
  width,
  height,
  lines = 1,
  className,
  children,
}: SkeletonProps) {
  const bones = useRef<HTMLSpanElement>(null);
  const last = useRef(children);
  const [boned, setBoned] = useState(loading);
  const [arrived, setArrived] = useState(false);
  const [had, setHad] = useState(!loading);
  if (loading && !boned) setBoned(true);
  if (!loading && boned && !arrived) setArrived(true);
  if (!loading && !had) setHad(true);
  if (!loading) last.current = children;
  const stale = loading && had;

  useEffect(() => {
    if (loading || !boned) return;
    return afterMotion([bones.current], () => setBoned(false), false);
  }, [loading, boned]);

  const style = { "--_width": width, "--_height": height } as CSSProperties;
  return (
    <span
      className={clsx("ui-skeleton", className)}
      data-shape={shape}
      aria-busy={loading || undefined}
      style={style}
    >
      {boned && (
        <span
          ref={bones}
          className="ui-skeleton-bones"
          data-leaving={loading ? undefined : ""}
          aria-hidden="true"
        >
          {Array.from({ length: shape === "text" ? Math.max(1, lines) : 1 }, (_, line) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines are identical and never reorder.
            <span key={line} className="ui-skeleton-bone" />
          ))}
        </span>
      )}
      {(!loading || stale) && (
        <span
          className="ui-skeleton-content"
          data-arrived={arrived ? "" : undefined}
          data-stale={stale ? "" : undefined}
        >
          {stale ? last.current : children}
        </span>
      )}
    </span>
  );
}
