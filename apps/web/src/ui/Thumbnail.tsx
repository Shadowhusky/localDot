import { clsx } from "clsx";
import type { MouseEvent, ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import { pressHandlers } from "./press.ts";

export interface ThumbnailButtonProps {
  // What pressing it does, such as "Watch from the start".
  label: string;
  onClick(event: MouseEvent<HTMLButtonElement>): void;
  className?: string;
  // Width over height; 16:10 unless the picture has its own shape, such as a portrait page.
  ratio?: number;
  current?: boolean;
  // The picture: an img, video or canvas filling the frame.
  children: ReactNode;
}

// A picture you can press, at 16:10, with the thumbnail's edge and the kit's press.
export function ThumbnailButton({
  label,
  onClick,
  className,
  ratio,
  current,
  children,
}: ThumbnailButtonProps) {
  return (
    <button
      {...pressHandlers}
      type="button"
      className={clsx("ui-thumbnail", className)}
      aria-label={label}
      aria-current={current || undefined}
      style={ratio ? { aspectRatio: ratio } : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// Laid over a picture: pressing it anywhere opens it large. The glyph at its centre shows under a
// pointer, and always where there is none to hover with.
export function PictureCover({
  label,
  onClick,
}: {
  label: string;
  onClick(event: MouseEvent<HTMLButtonElement>): void;
}) {
  return (
    <button
      {...pressHandlers}
      type="button"
      className="ui-picture-cover"
      aria-label={label}
      onClick={onClick}
    >
      <span className="ui-picture-cover-glyph">
        <Icon name="expand" size={18} />
      </span>
    </button>
  );
}
