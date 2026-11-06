// biome-ignore-all lint/suspicious/noArrayIndexKey: Excerpt rows and cells have no identity but their position.
// biome-ignore-all lint/a11y/noNoninteractiveTabindex: A wide or long excerpt scrolls inside its well, so keyboard users can focus it.
import { type FileKind, type PreviewReason, viewerKind } from "@localdot/protocol";
import { type ReactNode, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { FileCard } from "../ui/Card.tsx";
import { Progress } from "../ui/Progress.tsx";
import type { FileRef } from "./api.ts";
import type { PreviewState } from "./usePreview.ts";
import { usePreviewUrl } from "./usePreviewUrl.ts";
import { MediaPlayer } from "./viewer/MediaView.tsx";

// A file with no preview simply gets its card; these say why one that could have had one hasn't.
const PROBLEMS: Partial<Record<PreviewReason, string>> = {
  computer_off: "Turn on your computer to preview this file.",
  busy: "Your computer is busy. Try again in a moment.",
  failed: "Couldn't make a preview.",
  missing: "This version is no longer available.",
};
const RETRY = new Set<PreviewReason>(["busy", "failed", "computer_off"]);

// What a file's card needs, wherever under its row it comes to show.
interface Card {
  name: string;
  meta: string;
  actions: ReactNode;
}

function Loading({ label }: { label: string }) {
  return (
    <div className="file-preview-loading" data-shape="picture" aria-busy="true">
      <Progress label={label} className="file-preview-progress" />
    </div>
  );
}

// A sound or a video the browser can play, in place under its row.
export function MediaPreview({
  api,
  file,
  kind,
  card,
}: {
  api: ApiClient;
  file: FileRef;
  kind: "audio" | "video";
  card: Card;
}) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState<"format" | "load" | null>(null);
  const url = usePreviewUrl(api, file, true, attempt);
  const retry = () => {
    setFailed(null);
    setAttempt((n) => n + 1);
  };
  if (failed === "format") return <FileCard {...card} />;
  if (failed === "load" || url === "failed")
    return <FileCard {...card} problem="Couldn't load this file." onRetry={retry} />;
  if (url === null) return <Loading label="Loading the player" />;
  return (
    <div className="file-preview-media" data-kind={kind}>
      <MediaPlayer key={attempt} url={url} kind={kind} name={card.name} onFail={setFailed} />
    </div>
  );
}

// What a file looks like inside: a picture or page, the first lines, or the first rows, and when it
// has none of those its card. Nothing in it is ever rendered as markup.
export function FilePreview({
  state,
  kind,
  name,
  meta,
  actions,
  onRetry,
}: {
  state: PreviewState;
  kind: FileKind;
  name: string;
  meta: string;
  // Open and Download, for the file's card.
  actions: ReactNode;
  onRetry(): void;
}) {
  const picture = kind === "image" || kind === "office" || kind === "pdf";
  if (kind === "attachment" && viewerKind(name) !== "details")
    return <FileCard name={name} meta={meta} actions={actions} />;
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
  if (state.state === "error")
    return (
      <FileCard
        name={name}
        meta={meta}
        actions={actions}
        problem={PROBLEMS.failed}
        onRetry={onRetry}
      />
    );
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
      <FileCard
        name={name}
        meta={meta}
        actions={actions}
        problem={PROBLEMS[p.reason]}
        onRetry={RETRY.has(p.reason) ? onRetry : undefined}
      />
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
