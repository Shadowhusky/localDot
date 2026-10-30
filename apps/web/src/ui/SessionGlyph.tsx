import { clsx } from "clsx";
import { Icon, type IconProps } from "./Icon.tsx";

export type SessionStatus =
  | "working"
  | "waiting"
  | "needs-you"
  | "idle"
  | "paused"
  | "done"
  | "stopped"
  | "failed";

export interface SessionGlyphProps {
  status: SessionStatus;
  label?: string;
  size?: IconProps["size"];
  className?: string;
}

// A conversation's status: its status-* icon, lit by the status (structure.css). The shape says it
// on its own, so the colour is never the only sign.
export function SessionGlyph({ status, label, size = 16, className }: SessionGlyphProps) {
  return (
    <Icon
      name={`status-${status}`}
      size={size}
      label={label}
      data-status={status}
      className={clsx("ui-session-glyph", className)}
    />
  );
}
