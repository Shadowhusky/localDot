// biome-ignore-all lint/suspicious/noArrayIndexKey: Read-only diff lines have no child state; line position identifies each span.
import { Fragment, useMemo } from "react";
import { diffStat } from "./activity.ts";
import type { AgentChange } from "./model.ts";
import { OutputCopy } from "./OutputCopy.tsx";
import "./output.css";
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

const KINDS = {
  hunk: "diff-hunk",
  add: "diff-add",
  remove: "diff-remove",
  line: "diff-line",
  note: "diff-eol",
} as const;
interface Numbered {
  kind: keyof typeof KINDS;
  line?: number;
}

// Each line takes its number from the hunk headers: the new file's for added and kept lines, the
// old file's for removed ones.
export function numberLines(lines: readonly string[]): Numbered[] {
  let old = 0,
    next = 0;
  return lines.map((line) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      return { kind: "hunk" };
    }
    if (line.startsWith("@@")) return { kind: "hunk" };
    if (line.startsWith("+")) return { kind: "add", line: next++ };
    if (line.startsWith("-")) return { kind: "remove", line: old++ };
    if (line.startsWith("\\")) return { kind: "note" };
    old++;
    return { kind: "line", line: next++ };
  });
}

// Inside a row that already says what changed, only the full path is repeated.
export function DiffViewer({
  change,
  compact = false,
}: {
  change: AgentChange;
  compact?: boolean;
}) {
  const preview = useMemo(() => diffPreview(change.patch), [change.patch]);
  const numbered = useMemo(() => numberLines(preview.lines), [preview.lines]);
  const stat = diffStat([preview.text]);
  return (
    <section className="diff-viewer" data-compact={compact || undefined} aria-label="File change">
      <p className="diff-head">
        <span className="diff-op" hidden={compact}>
          {change.type === "memory"
            ? "Memory"
            : change.op === "create"
              ? "Created"
              : change.op === "delete"
                ? "Deleted"
                : "Changed"}
        </span>
        <span className="diff-path">{change.path.slice(0, DIFF_LIMITS.path)}</span>
        {stat && !compact && <span className="diff-stat num">{stat}</span>}
      </p>
      {preview.unavailable ? (
        <p className="diff-empty">No text diff available.</p>
      ) : (
        <>
          <section className="diff-text" aria-label="Unified text diff">
            <pre>
              {preview.lines.map((line, index) => {
                const row = numbered[index];
                return (
                  <Fragment key={index}>
                    <span className={KINDS[row?.kind ?? "line"]} data-line={row?.line}>
                      {line}
                    </span>
                    {index < preview.lines.length - 1 ? "\n" : ""}
                  </Fragment>
                );
              })}
            </pre>
          </section>
          <div className="diff-foot">
            {(change.truncated || preview.truncated) && (
              <span className="diff-shortened">Shortened to the kept text.</span>
            )}
            <OutputCopy text={preview.text} label="Copy diff" />
          </div>
        </>
      )}
    </section>
  );
}
