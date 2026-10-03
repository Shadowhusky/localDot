// Unified diffs for the diff panel (file.change) and the memory card (memory.change). A line diff
// by Myers' O(ND) algorithm; texts too far apart to diff within the edit budget become one hunk
// that replaces everything, which is still a correct patch.
// Bound the trace to about 18 MiB before falling back to a whole-file replacement.
const MAX_EDITS = 1500;

type Op = { kind: " " | "-" | "+"; line: string };

function splitLines(text: string): string[] {
  // A terminator is part of a line: adding or removing the final newline is an edit too.
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function render(op: Op): string {
  return `${op.kind}${op.line}${op.line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`;
}

function myers(a: string[], b: string[]): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) {
        x = v[offset + k + 1] ?? 0;
      } else {
        x = (v[offset + k - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
    v = next;
  }
  return undefined;
}

function backtrack(
  trace: Int32Array[],
  a: string[],
  b: string[],
  depth: number,
  offset: number,
): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = depth; d > 0; d--) {
    const v = trace[d] as Int32Array;
    const k = x - y;
    const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", line: a[x - 1] as string });
      x--;
      y--;
    }
    if (down) ops.push({ kind: "+", line: b[y - 1] as string });
    else ops.push({ kind: "-", line: a[x - 1] as string });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: " ", line: a[x - 1] as string });
    x--;
    y--;
  }
  return ops.reverse();
}

export interface DiffOptions {
  path: string;
  context?: number;
}

export function unifiedDiff(before: string, after: string, opts: DiffOptions): string {
  if (before === after) return "";
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = myers(a, b) ?? [
    ...a.map((line): Op => ({ kind: "-", line })),
    ...b.map((line): Op => ({ kind: "+", line })),
  ];
  const context = opts.context ?? 3;
  if (!Number.isSafeInteger(context) || context < 0)
    throw new RangeError("diff context must be a nonnegative integer");
  const header = `--- a/${opts.path}\n+++ b/${opts.path}\n`;
  const hunks: string[] = [];
  let i = 0;
  // Line numbers (1-based) in a and b at op index i.
  const posA: number[] = [];
  const posB: number[] = [];
  let la = 1;
  let lb = 1;
  for (const op of ops) {
    posA.push(la);
    posB.push(lb);
    if (op.kind !== "+") la++;
    if (op.kind !== "-") lb++;
  }
  while (i < ops.length) {
    while (i < ops.length && ops[i]?.kind === " ") i++;
    if (i >= ops.length) break;
    const start = Math.max(0, i - context);
    let end = i;
    let lastChange = i;
    while (end < ops.length) {
      if (ops[end]?.kind !== " ") lastChange = end;
      else if (end - lastChange > 2 * context) break;
      end++;
    }
    const stop = Math.min(ops.length, lastChange + context + 1);
    const slice = ops.slice(start, stop);
    const oldCount = slice.filter((o) => o.kind !== "+").length;
    const newCount = slice.filter((o) => o.kind !== "-").length;
    const oldStart = oldCount === 0 ? (posA[start] ?? 1) - 1 : (posA[start] ?? 1);
    const newStart = newCount === 0 ? (posB[start] ?? 1) - 1 : (posB[start] ?? 1);
    hunks.push(
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${slice.map(render).join("")}`,
    );
    i = stop;
  }
  return header + hunks.join("");
}

// Patches go into events, which have no size cap of their own: a huge one is cut at a line.
export function clipPatch(patch: string, maxChars = 64_000): string {
  if (patch.length <= maxChars) return patch;
  const cut = patch.slice(0, maxChars);
  return `${cut.slice(0, cut.lastIndexOf("\n") + 1)}… (diff cut at ${maxChars} characters)\n`;
}
