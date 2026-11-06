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

// The characters of a file's name that always stay in sight: the first few, its extension and the
// few before that. A name too short to keep both ends gives way from its end alone.
const START = 4;
export function fileNameTail(name: string): number {
  const chars = [...name];
  const dot = chars.lastIndexOf(".");
  const extension = dot > 0 ? chars.length - dot : 0;
  const room = chars.length - START;
  return room < extension ? 0 : Math.min(extension + 3, room);
}

// A file's name on one line: what lies between its two ends gives way. Its text is the name itself,
// so what reads or copies it gets the name once.
export function MiddleName({ name, className }: { name: string; className?: string }) {
  const chars = [...name];
  const end = chars.length - fileNameTail(name);
  const start = Math.min(START, end);
  const between = chars.slice(start, end).join("");
  return (
    <span className={clsx("ui-middle-name", className)} title={name}>
      <span>{chars.slice(0, start).join("")}</span>
      {between && <span className="ui-middle-name-between">{between}</span>}
      <span>{chars.slice(end).join("")}</span>
    </span>
  );
}
