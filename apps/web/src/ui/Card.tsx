import { clsx } from "clsx";
import type { ComponentProps, ReactNode } from "react";

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
  className?: string;
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1, dot + 5).toUpperCase() : "";
}

// One file in a file card: its type on a tile, its name and where it is, and what you can do with it.
export function FileRow({ name, meta, actions, className }: FileRowProps) {
  return (
    <div className={clsx("ui-file-row", className)}>
      <span className="ui-file-tile" aria-hidden="true">
        {extension(name)}
      </span>
      <span className="ui-file-text">
        <span className="ui-file-name">{name}</span>
        {meta && <span className="ui-file-meta">{meta}</span>}
      </span>
      {actions && <span className="ui-file-actions">{actions}</span>}
    </div>
  );
}
