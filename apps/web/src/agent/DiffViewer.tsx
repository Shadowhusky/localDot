// biome-ignore-all lint/suspicious/noArrayIndexKey: Read-only diff lines have no child state; line position identifies each span.
import { Fragment, useMemo } from "react";
import { DIFF_LIMITS, diffPreview } from "../deliverables/viewer/diff.ts";
import { diffStat } from "./activity.ts";
import { changedFiles } from "./changed-files.ts";
import type { AgentChange } from "./model.ts";
import { OutputCopy } from "./OutputCopy.tsx";
import { StepPreviewButton } from "./StepPreview.tsx";
import "./output.css";

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

// Inside a row that already says what changed, only the full path is repeated. With the task it
// belongs to, its preview opens the file on the computer at its changes, beside the file itself.
export function DiffViewer({
  change,
  compact = false,
  task,
}: {
  change: AgentChange;
  compact?: boolean;
  task?: { sessionId: string; changes: readonly AgentChange[] };
}) {
  const preview = useMemo(() => diffPreview(change.patch), [change.patch]);
  const file = useMemo(
    () =>
      task &&
      change.type === "file" &&
      changedFiles(task.sessionId, task.changes).find((entry) => entry.path === change.path),
    [task, change],
  );
  const numbered = useMemo(() => numberLines(preview.lines), [preview.lines]);
  const stat = diffStat([preview.text]);
  return (
    <section
      className="diff-viewer step-preview-resource"
      data-compact={compact || undefined}
      aria-label="File change"
    >
      {!preview.unavailable && (
        <StepPreviewButton
          label="Preview code changes"
          resource={
            file
              ? { kind: "files", entries: [file], index: 0, view: "changes" }
              : { kind: "text", name: change.path, text: preview.text, diff: true }
          }
        />
      )}
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
