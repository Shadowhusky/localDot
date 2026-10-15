import { clsx } from "clsx";
import { pressHandlers } from "./press.ts";

export interface HitButtonProps {
  // What pressing it does, such as "Change your dot".
  label: string;
  onClick(trigger: HTMLButtonElement): void;
  // A popover it opens, and whether it is open.
  expanded?: boolean;
  className?: string;
}

// A press target with no face, laid under something drawn in another layer, such as dot flying in
// the presence layer: round, with the kit's press and focus ring, in whatever box it is given.
export function HitButton({ label, onClick, expanded, className }: HitButtonProps) {
  return (
    <button
      {...pressHandlers}
      type="button"
      className={clsx("ui-hit", className)}
      aria-label={label}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      aria-expanded={expanded}
      onClick={(event) => onClick(event.currentTarget)}
    />
  );
}
