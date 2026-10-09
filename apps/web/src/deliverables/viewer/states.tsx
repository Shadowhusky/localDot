import type { ReactNode } from "react";
import { Progress } from "../../ui/Progress.tsx";

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1, dot + 5).toUpperCase() : "FILE";
}

// While a file loads: the shape of what is coming, no words that flash past.
export function ViewerLoading({ label }: { label: string }) {
  return (
    <div className="viewer-center" aria-busy="true">
      <Progress label={label} className="viewer-progress" />
    </div>
  );
}

// A calm stop in the stage: the file's tile, what happened, and what to do instead.
export function ViewerMessage({
  name,
  title,
  children,
  action,
}: {
  name: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="viewer-center">
      <div className="viewer-message">
        <span className="viewer-tile" aria-hidden="true">
          {extension(name)}
        </span>
        <p className="viewer-message-title">{title}</p>
        {children && <div className="viewer-message-detail">{children}</div>}
        {action}
      </div>
    </div>
  );
}

// A row of controls above the file, and a note at its end; nothing when it has neither.
export function ViewerBar({ children, note }: { children?: ReactNode; note?: ReactNode }) {
  if (!children && !note) return null;
  return (
    <div className="viewer-bar">
      <div className="viewer-bar-controls">{children}</div>
      {note && <div className="viewer-bar-note">{note}</div>}
    </div>
  );
}
