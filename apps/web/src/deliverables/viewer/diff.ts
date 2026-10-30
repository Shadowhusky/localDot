export const DIFF_LIMITS = Object.freeze({ chars: 64_000, lines: 2000, path: 1024 });
export function diffPreview(patch: string | undefined) {
  // Inspect and render only the bounded preview, regardless of the source size.
  const source = patch?.slice(0, DIFF_LIMITS.chars);
  if (
    !source ||
    source.includes("\0") ||
    /(^|\n)(Binary files .+ differ|GIT binary patch)(\n|$)/.test(source)
  )
    return {
      text: "",
      lines: [] as string[],
      truncated: (patch?.length ?? 0) > DIFF_LIMITS.chars,
      unavailable: true,
    };
  let bounded = "";
  for (const char of source.toWellFormed().replace(/\r\n?/g, "\n")) {
    const code = char.charCodeAt(0);
    bounded +=
      (code < 0x20 && code !== 9 && code !== 10) || (code >= 0x7f && code <= 0x9f)
        ? String.fromCharCode(code < 0x20 ? 0x2400 + code : 0x2421)
        : char;
  }
  const all = bounded.split("\n"),
    lines = all.slice(0, DIFF_LIMITS.lines);
  return {
    text: lines.join("\n"),
    lines,
    truncated: (patch?.length ?? 0) > DIFF_LIMITS.chars || all.length > DIFF_LIMITS.lines,
    unavailable: false,
  };
}

export interface DiffLine {
  kind: "add" | "remove" | "same" | "hunk" | "note";
  text: string;
  old?: number;
  new?: number;
}
// One row of the side-by-side view: the old file's line on the left, the new file's on the right.
export interface DiffPair {
  hunk?: string;
  left?: DiffLine;
  right?: DiffLine;
}

// A patch as numbered lines, its file headers left out: the viewer already names the file.
export function diffLines(patch: string | undefined): {
  lines: DiffLine[];
  truncated: boolean;
} | null {
  const preview = diffPreview(patch);
  if (preview.unavailable) return null;
  let old = 1;
  let next = 1;
  let started = false;
  const lines: DiffLine[] = [];
  // A patch's final newline ends its last line rather than starting another.
  const patchLines = preview.lines.at(-1) === "" ? preview.lines.slice(0, -1) : preview.lines;
  for (const line of patchLines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      started = true;
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      lines.push({ kind: "hunk", text: line });
    } else if (!started && /^(?:---|\+\+\+) /.test(line)) continue;
    else if (line.startsWith("@@")) lines.push({ kind: "hunk", text: line });
    else if (line.startsWith("+")) lines.push({ kind: "add", text: line.slice(1), new: next++ });
    else if (line.startsWith("-")) lines.push({ kind: "remove", text: line.slice(1), old: old++ });
    else if (line.startsWith("\\")) lines.push({ kind: "note", text: line });
    else lines.push({ kind: "same", text: line.slice(1), old: old++, new: next++ });
  }
  return { lines, truncated: preview.truncated };
}

// Removed lines face the added lines that replace them; kept lines face themselves.
export function sideBySide(lines: readonly DiffLine[]): DiffPair[] {
  const pairs: DiffPair[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      pairs.push({ left: removed[i], right: added[i] });
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === "remove") {
      if (added.length) flush();
      removed.push(line);
    } else if (line.kind === "add") added.push(line);
    else {
      flush();
      if (line.kind === "hunk") pairs.push({ hunk: line.text });
      else if (line.kind === "same") pairs.push({ left: line, right: line });
    }
  }
  flush();
  return pairs;
}

export function diffCounts(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added++;
    else if (line.kind === "remove") removed++;
  }
  return { added, removed };
}
