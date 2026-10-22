import { clsx } from "clsx";
import { type ComponentProps, type ReactNode, useId } from "react";
import { Icon } from "./Icon.tsx";
import { pressHandlers } from "./press.ts";

export interface CardProps extends ComponentProps<"div"> {
  // Raised holds content with 14 px of room; file holds file rows edge to edge. Never one in another.
  variant?: "raised" | "file";
}

export function Card({ variant = "raised", className, ...props }: CardProps) {
  return <div {...props} className={clsx("ui-card", className)} data-variant={variant} />;
}

export interface FileRowProps {
  name: string;
  // "2 KB · Documents"
  meta?: ReactNode;
  // Open, download and the like, at the row's end.
  actions?: ReactNode;
  // The row opens and closes what sits under it, such as the file's preview.
  expanded?: boolean;
  onToggle?(): void;
  // The id of what the row opens, and what the row says it does.
  controls?: string;
  toggleLabel?: string;
  // The file's own picture over its tile, such as an image's; its type shows until it arrives.
  thumbnail?: ReactNode;
  // One line 40 px tall, the meta beside the name: a list read in passing, such as a result's files
  // in the chat.
  compact?: boolean;
  className?: string;
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1, dot + 5).toUpperCase() : "";
}

// One file in a file card: its type on a tile, its name and where it is, and what you can do with it.
// A long name gives way in the middle, so its end (the extension) stays in view.
export function FileRow({
  name,
  meta,
  actions,
  expanded = false,
  onToggle,
  controls,
  toggleLabel,
  thumbnail,
  compact = false,
  className,
}: FileRowProps) {
  const tail = Math.min(8, Math.max(0, name.length - 4));
  const body = (
    <>
      {onToggle && <Icon name="chevron-down" size={12} className="ui-file-chevron" />}
      <span className="ui-file-tile" aria-hidden="true">
        {extension(name)}
        {thumbnail}
      </span>
      <span className="ui-file-text">
        <span className="ui-file-name" title={name}>
          <span className="ui-file-name-head">{name.slice(0, name.length - tail)}</span>
          <span className="ui-file-name-tail">{name.slice(name.length - tail)}</span>
        </span>
        {meta && <span className="ui-file-meta">{meta}</span>}
      </span>
    </>
  );
  return (
    <div
      className={clsx("ui-file-row", className)}
      data-expanded={expanded || undefined}
      data-compact={compact || undefined}
    >
      {onToggle ? (
        <button
          {...pressHandlers}
          type="button"
          className="ui-file-main"
          aria-expanded={expanded}
          aria-controls={controls}
          aria-label={toggleLabel}
          onClick={onToggle}
        >
          {body}
        </button>
      ) : (
        <span className="ui-file-main">{body}</span>
      )}
      {actions && <span className="ui-file-actions">{actions}</span>}
    </div>
  );
}

export interface PlayRowProps {
  // What pressing the row does, such as "Watch replay (1:42)".
  label: string;
  onPlay(): void;
  // The recording's picture, under the play glyph.
  poster?: ReactNode;
  title: ReactNode;
  // Beside the title, giving way first; it describes the row.
  detail?: ReactNode;
  // A menu and the like, at the row's end.
  actions?: ReactNode;
}

// A recording beside files, as tall as a compact file row: its picture under a play glyph, a title
// and a line about it, all one press that plays it.
export function PlayRow({ label, onPlay, poster, title, detail, actions }: PlayRowProps) {
  const describedBy = useId();
  return (
    <div className="ui-file-row" data-compact="" data-play="">
      <button
        {...pressHandlers}
        type="button"
        className="ui-file-main"
        aria-label={label}
        aria-describedby={detail ? describedBy : undefined}
        onClick={onPlay}
      >
        <span className="ui-file-tile" aria-hidden="true">
          {poster}
          <span className="ui-file-play">
            <Icon name="play" size={12} />
          </span>
        </span>
        <span className="ui-file-text">
          <span className="ui-file-name">{title}</span>
          {detail && (
            <span id={describedBy} className="ui-file-meta">
              {detail}
            </span>
          )}
        </span>
      </button>
      {actions && <span className="ui-file-actions">{actions}</span>}
    </div>
  );
}
