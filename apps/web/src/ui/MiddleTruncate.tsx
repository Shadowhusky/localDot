import { clsx } from "clsx";
import { VisuallyHidden } from "./VisuallyHidden.tsx";

// The end a long value keeps in sight: its file name, an email's domain or a name's last few
// characters, never more than half of it.
export function tailOf(text: string): number {
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("@"));
  const keep = cut > 0 ? text.length - cut : 8;
  return Math.min(keep, 24, Math.floor(text.length / 2));
}

// A value too long for its line loses its middle, so both ends stay readable; the whole value is
// its tooltip and what a screen reader reads. `tail` keeps that many last characters instead.
export function MiddleTruncate({
  text,
  tail = tailOf(text),
  className,
}: {
  text: string;
  tail?: number;
  className?: string;
}) {
  const at = text.length - tail;
  return (
    <span className={clsx("ui-middle", className)} title={text}>
      <span aria-hidden="true">{text.slice(0, at)}</span>
      <span aria-hidden="true">{text.slice(at)}</span>
      <VisuallyHidden>{text}</VisuallyHidden>
    </span>
  );
}
