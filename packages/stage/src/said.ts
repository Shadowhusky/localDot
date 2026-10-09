// The band clamps a line to its own lines at whatever width it has; this only stops a runaway
// sentence, at about two lines beside dot on the widest stage.
const MAX_CHARS = 240;
const STOP = /[.!?…]["'”’)\]]*$/;

// A line dot gave as plain words on one line.
export function plainText(text: string): string {
  return cut(plainLine(text));
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
  return cut(units.at(-1) ?? "");
}

// A runaway line cut at a word, with an ellipsis.
function cut(line: string): string {
  if (line.length <= MAX_CHARS) return line;
  const head = line.slice(0, MAX_CHARS);
  const space = head.lastIndexOf(" ");
  return `${(space > MAX_CHARS / 2 ? head.slice(0, space) : head).replace(/[\s,;:.–—-]+$/, "")}…`;
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
