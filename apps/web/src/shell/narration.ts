import type { Said } from "../agent/model.ts";
import type { StatusRow } from "../session/status.ts";

// Rows where dot is at work, so its own words can stand in for the status caption.
const AT_WORK = new Set<StatusRow>(["acting", "working", "thinking", "observing"]);
// The band clamps the line to its own lines at whatever width it has; this only stops a runaway
// sentence, at about two lines beside dot on the widest stage.
const MAX_CHARS = 240;
const STOP = /[.!?…]["'”’)\]]*$/;

// The band's line while dot works: its own latest sentence for the step at hand, or the status
// caption when it has said nothing since the last step ended.
export function narrationLine(
  row: StatusRow,
  caption: string,
  said: Said | null | undefined,
): string {
  if (!AT_WORK.has(row) || !said) return caption;
  return lastSentence(said.text, !said.open) || caption;
}

// The last whole sentence of dot's words as one plain line, cut at a word with an ellipsis when
// long. Words still streaming without a stop may yet go on, so they wait.
export function lastSentence(text: string, closed: boolean): string {
  const lines = text.replace(/```[\s\S]*?(?:```|$)/g, "\n").split("\n");
  const ended = closed || text.endsWith("\n");
  const units: string[] = [];
  lines.forEach((line, index) => {
    const plain = plainLine(line);
    if (!plain) return;
    // Two runs of words can meet without a space: "returns.Checking".
    const parts = plain.split(/(?<=[.!?…]["'”’)\]]*)(?:\s+(?=\S)|(?=[A-Z][a-z]))/);
    const last = index === lines.length - 1 && !ended ? parts.pop() : undefined;
    units.push(...parts);
    if (last && STOP.test(last)) units.push(last);
  });
  const sentence = units.at(-1) ?? "";
  if (sentence.length <= MAX_CHARS) return sentence;
  const cut = sentence.slice(0, MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

function plainLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("|")) return "";
  return trimmed
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|[\s(])[*_]([^*_]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}
