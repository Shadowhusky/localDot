// biome-ignore-all lint/suspicious/noArrayIndexKey: Excerpt rows and cells have no identity but their position.
// biome-ignore-all lint/a11y/noNoninteractiveTabindex: A wide or long excerpt scrolls inside its well, so keyboard users can focus it.
import { type FileKind, type PreviewReason, viewerKind } from "@localdot/protocol";
import { Button } from "../ui/Button.tsx";
import { Progress } from "../ui/Progress.tsx";
import type { PreviewState } from "./usePreview.ts";

export const PREVIEW_REASONS: Record<PreviewReason, string> = {
  attachment: "No preview for this kind of file.",
  binary: "No preview: this file isn't text.",
  too_large: "Too large to preview.",
  computer_off: "Turn on your computer to preview this file.",
  busy: "Your computer is busy. Try again in a moment.",
  failed: "Couldn't make a preview.",
  missing: "This version is no longer available.",
};
const RETRY = new Set<PreviewReason>(["busy", "failed", "computer_off"]);

function Note({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <p className="file-preview-note">
      <span>{text}</span>
      {onRetry && (
        <Button variant="quiet" size="sm" className="file-preview-retry" onClick={onRetry}>
          Try again
        </Button>
      )}
    </p>
  );
}

// What a file looks like inside: a picture or page, the first lines, or the first rows. Nothing in
// it is ever rendered as markup.
export function FilePreview({
  state,
  kind,
  name,
  onRetry,
  opens = false,
}: {
  state: PreviewState;
  kind: FileKind;
  name: string;
  onRetry(): void;
  // The row's Open shows the file in full.
  opens?: boolean;
}) {
  const picture = kind === "image" || kind === "office" || kind === "pdf";
  if (kind === "attachment" && viewerKind(name) !== "details")
    return (
      <Note
        text={
          opens && viewerKind(name) !== "details"
            ? "Press Open to see this file."
            : PREVIEW_REASONS.attachment
        }
      />
    );
  if (state.state === "waiting" || state.state === "loading")
    return (
      <div
        className="file-preview-loading"
        data-shape={picture ? "picture" : "lines"}
        aria-busy="true"
      >
        <Progress
          label={
            kind === "office" || kind === "pdf"
              ? "Making a preview on your computer"
              : "Loading preview"
          }
          className="file-preview-progress"
        />
        {(kind === "office" || kind === "pdf") && (
          <span className="file-preview-caption">Making a preview on your computer…</span>
        )}
      </div>
    );
  if (state.state === "error") return <Note text={PREVIEW_REASONS.failed} onRetry={onRetry} />;
  if (state.state === "image")
    return (
      <figure className="file-preview-picture">
        <img src={state.url} alt={`Preview of ${name}`} draggable={false} />
        {state.madeBy === "computer" && (
          <figcaption className="file-preview-caption">Preview made on your computer</figcaption>
        )}
      </figure>
    );
  const p = state.preview;
  if (p.kind === "none")
    return (
      <Note text={PREVIEW_REASONS[p.reason]} onRetry={RETRY.has(p.reason) ? onRetry : undefined} />
    );
  if (p.kind === "text")
    return (
      <section className="file-preview-excerpt" aria-label={`First lines of ${name}`}>
        <pre className="file-preview-text" tabIndex={0}>
          {p.lines.join("\n")}
        </pre>
        {p.truncated && <p className="file-preview-caption">First {p.lines.length} lines</p>}
      </section>
    );
  const [head, ...rows] = p.rows;
  return (
    <div className="file-preview-excerpt">
      <section
        className="md-table file-preview-table"
        aria-label={`First rows of ${name}`}
        tabIndex={0}
      >
        <table>
          {head && (
            <thead>
              <tr>
                {head.map((cell, c) => (
                  <th key={c} scope="col">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {p.truncated && <p className="file-preview-caption">First {p.rows.length} rows</p>}
    </div>
  );
}
