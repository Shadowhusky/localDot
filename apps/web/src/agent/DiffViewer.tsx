// biome-ignore-all lint/suspicious/noArrayIndexKey: Read-only diff lines have no child state; line position identifies each span.
import { useMemo } from "react";
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
export function DiffViewer({ change }: { change: AgentChange }) {
  const preview = useMemo(() => diffPreview(change.patch), [change.patch]);
  return (
    <section className="diff-viewer" aria-label="File change">
      <h3>{change.path.slice(0, DIFF_LIMITS.path)}</h3>
      <p>
        {change.type === "memory"
          ? "Memory change"
          : change.op === "create"
            ? "Created file"
            : change.op === "delete"
              ? "Deleted file"
              : "Modified file"}
      </p>
      {change.truncated || preview.truncated ? (
        <p className="history-note">Diff preview shortened.</p>
      ) : null}
      {preview.unavailable ? (
        <p>No text diff available.</p>
      ) : (
        <>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the bounded diff. */}
          <section className="diff-text" tabIndex={0} aria-label="Unified text diff">
            <pre>
              {preview.lines.map((line, index) => (
                <span
                  key={index}
                  className={
                    line.startsWith("@@")
                      ? "diff-hunk"
                      : line.startsWith("+")
                        ? "diff-add"
                        : line.startsWith("-")
                          ? "diff-remove"
                          : "diff-line"
                  }
                >
                  {line}
                  {index < preview.lines.length - 1 ? "\n" : ""}
                </span>
              ))}
            </pre>
          </section>
          <OutputCopy text={preview.text} label="Copy shown diff" />
        </>
      )}
    </section>
  );
}
