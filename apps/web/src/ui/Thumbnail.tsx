import { clsx } from "clsx";
import type { ReactNode } from "react";
import { pressHandlers } from "./press.ts";

export interface ThumbnailButtonProps {
  // What pressing it does, such as "Watch from the start".
  label: string;
  onClick(): void;
  className?: string;
  // The picture: an img, video or canvas filling the 16:10 frame.
  children: ReactNode;
}

// A picture you can press, at 16:10, with the thumbnail's edge and the kit's press.
export function ThumbnailButton({ label, onClick, className, children }: ThumbnailButtonProps) {
  return (
    <button
      {...pressHandlers}
      type="button"
      className={clsx("ui-thumbnail", className)}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
