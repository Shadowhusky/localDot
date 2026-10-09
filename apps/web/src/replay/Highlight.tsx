import { SEARCH_MARK_END, SEARCH_MARK_START } from "@localdot/protocol";

const MARKED = new RegExp(`(${SEARCH_MARK_START}[^${SEARCH_MARK_END}]*${SEARCH_MARK_END})`, "u");

// Keeps at most this many characters before the first match, so a one-line row shows the match.
function lead(text: string, max: number): string {
  const first = text.indexOf(SEARCH_MARK_START);
  if (first <= max) return text;
  const space = text.indexOf(" ", first - max);
  return `…${text.slice(space >= 0 && space < first ? space + 1 : first - max)}`;
}

// A snippet with the matched words marked, as text: nothing in it is ever read as markup.
export function Highlight({ text, before }: { text: string; before?: number }) {
  const parts: { at: number; text: string; marked: boolean }[] = [];
  let at = 0;
  for (const piece of (before === undefined ? text : lead(text, before)).split(MARKED)) {
    if (piece) {
      const marked = piece.startsWith(SEARCH_MARK_START);
      parts.push({ at, text: marked ? piece.slice(1, -1) : piece, marked });
    }
    at += piece.length;
  }
  return (
    <>
      {parts.map((part) =>
        part.marked ? (
          <mark key={part.at} className="replay-mark">
            {part.text}
          </mark>
        ) : (
          <span key={part.at}>{part.text.replaceAll(SEARCH_MARK_END, "")}</span>
        ),
      )}
    </>
  );
}
