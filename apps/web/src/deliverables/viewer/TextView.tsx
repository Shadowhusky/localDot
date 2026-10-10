import { type TextFileReply, type TextFormat, textFormat } from "@localdot/protocol";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SafeMarkdown } from "../../agent/SafeMarkdown.tsx";
import { count } from "../../copy/format.ts";
import type { ApiClient } from "../../lib/api.ts";
import { Button } from "../../ui/Button.tsx";
import { SegmentedControl } from "../../ui/SegmentedControl.tsx";
import { Switch } from "../../ui/Switch.tsx";
import { loadText } from "../api.ts";
import { CodeLines } from "./CodeLines.tsx";
import { JsonTree } from "./JsonTree.tsx";
import { ViewerBar, ViewerLoading, ViewerMessage } from "./states.tsx";

type Loaded = TextFileReply | "failed" | null;

export function useText(
  api: ApiClient,
  sessionId: string,
  name: string,
  version: number | null,
  from: "start" | "end",
  attempt = 0,
): Loaded {
  const [text, setText] = useState<Loaded>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt deliberately restarts a failed request.
  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    loadText(api, sessionId, name, version, from, controller.signal).then(
      (reply) => !controller.signal.aborted && setText(reply),
      () => !controller.signal.aborted && setText("failed"),
    );
    return () => controller.abort();
  }, [api, sessionId, name, version, from, attempt]);
  return text;
}

const TEXT_REASONS = {
  binary: "This file isn't text",
  missing: "This version is no longer available",
} as const;

// Text as the file means it: Markdown formatted, JSON as a tree that folds, a log from its end, and
// code numbered and coloured. Keys in the text are masked by the daemon before it arrives.
export function TextView({
  api,
  sessionId,
  name,
  version,
  download,
}: {
  api: ApiClient;
  sessionId: string;
  name: string;
  version: number | null;
  download?: ReactNode;
}) {
  const format = textFormat(name);
  const [attempt, setAttempt] = useState(0);
  const text = useText(api, sessionId, name, version, format === "log" ? "end" : "start", attempt);
  if (text === null) return <ViewerLoading label="Loading the text" />;
  if (text === "failed" || text.kind === "none")
    return (
      <ViewerMessage
        name={name}
        action={
          text === "failed" ? (
            <Button size="md" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          ) : (
            download
          )
        }
        title={
          text !== "failed" && (text.reason === "binary" || text.reason === "missing")
            ? TEXT_REASONS[text.reason]
            : "Can't show this file"
        }
      >
        Download the file to open it in another app.
      </ViewerMessage>
    );
  return <TextBody name={name} format={format} reply={text} />;
}

function TextBody({
  name,
  format,
  reply,
}: {
  name: string;
  format: TextFormat;
  reply: Extract<TextFileReply, { kind: "text" }>;
}) {
  // A file's final newline ends its last line rather than starting another.
  const lines = useMemo(
    () => (reply.lines.at(-1) === "" ? reply.lines.slice(0, -1) : reply.lines),
    [reply],
  );
  const joined = useMemo(() => lines.join("\n"), [lines]);
  const json = useMemo(() => {
    if (format !== "json" || reply.truncated) return undefined;
    try {
      return { value: JSON.parse(joined) as unknown };
    } catch {
      return undefined;
    }
  }, [format, reply, joined]);
  const [shape, setShape] = useState(json ? "tree" : "text");
  const [wrap, setWrap] = useState(format !== "code");
  const scroller = useRef<HTMLDivElement>(null);
  // A log opens at its end, where the latest lines are.
  useLayoutEffect(() => {
    const host = scroller.current?.querySelector(".viewer-code");
    if (format === "log" && host) host.scrollTop = host.scrollHeight;
  }, [format]);
  const note = reply.truncated
    ? `${reply.from === "end" ? "Last" : "First"} ${count(lines.length, "line", "lines")}`
    : undefined;
  if (format === "markdown")
    return (
      <>
        <ViewerBar note={note} />
        <div className="viewer-stage viewer-doc">
          <div className="viewer-doc-page">
            <SafeMarkdown text={joined} shortened="Showing the start of this file." />
          </div>
        </div>
      </>
    );
  return (
    <>
      <ViewerBar note={note}>
        {json && (
          <SegmentedControl
            size={28}
            aria-label="Show as"
            value={shape}
            items={[
              { value: "tree", label: "Tree" },
              { value: "text", label: "Text" },
            ]}
            onValueChange={setShape}
          />
        )}
        {!(json && shape === "tree") && (
          <Switch
            className="viewer-wrap"
            label="Wrap lines"
            checked={wrap}
            onCheckedChange={setWrap}
          />
        )}
      </ViewerBar>
      <div ref={scroller} className="viewer-stage viewer-text">
        {json && shape === "tree" ? (
          <JsonTree value={json.value} label={`Contents of ${name}`} />
        ) : (
          <CodeLines
            lines={lines}
            name={format === "json" ? "a.json" : name}
            wrap={wrap}
            numbered={reply.from === "start"}
            label={`Contents of ${name}`}
          />
        )}
      </div>
    </>
  );
}
