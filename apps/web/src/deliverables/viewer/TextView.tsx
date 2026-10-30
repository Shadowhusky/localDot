import { type TextFileReply, type TextFormat, textFormat } from "@localdot/protocol";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { OutputCopy } from "../../agent/OutputCopy.tsx";
import { count } from "../../copy/format.ts";
import type { ApiClient } from "../../lib/api.ts";
import { Button } from "../../ui/Button.tsx";
import { Switch } from "../../ui/Switch.tsx";
import { type FileRef, loadText, onComputer } from "../api.ts";
import { CodeLines } from "./CodeLines.tsx";
import { JsonTree } from "./JsonTree.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import { ViewerBar, ViewerLoading, ViewerMessage, ViewSwitch } from "./states.tsx";
import type { ViewChoice } from "./views.ts";

type Loaded = TextFileReply | "failed" | null;

export function useText(api: ApiClient, file: FileRef, from: "start" | "end", attempt = 0): Loaded {
  const [text, setText] = useState<Loaded>(null);
  // A file is named by its parts, so a new object for the same file reads nothing again.
  const key = JSON.stringify(file);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the file; attempt deliberately restarts a failed request.
  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    loadText(api, file, from, controller.signal).then(
      (reply) => !controller.signal.aborted && setText(reply),
      () => !controller.signal.aborted && setText("failed"),
    );
    return () => controller.abort();
  }, [api, key, from, attempt]);
  return text;
}

const TEXT_REASONS = {
  binary: "This file isn't text",
  missing: "This version is no longer available",
  computer_off: "Turn on your computer to see this file",
  busy: "Your computer is busy. Try again in a moment",
} as const;

// Text as the file means it: Markdown formatted, JSON as a tree that folds, a log from its end, and
// code numbered and coloured. Keys in the text are masked by the daemon before it arrives.
export function TextView({
  api,
  file,
  download,
  choice,
}: {
  api: ApiClient;
  file: FileRef;
  download?: ReactNode;
  // Shown as text whatever the viewer's choice, unless it is the file's rendered view.
  choice?: ViewChoice;
}) {
  const { name } = file;
  const format = textFormat(name);
  const [attempt, setAttempt] = useState(0);
  const text = useText(api, file, format === "log" ? "end" : "start", attempt);
  const bar = choice && choice.items.length > 1 && (
    <ViewerBar>
      <ViewSwitch choice={choice} />
    </ViewerBar>
  );
  if (text === null)
    return (
      <>
        {bar}
        <ViewerLoading label="Loading the text" />
      </>
    );
  const reason = text !== "failed" && text.kind === "none" ? text.reason : null;
  if (text === "failed" || text.kind === "none")
    return (
      <>
        {bar}
        <ViewerMessage
          name={name}
          action={
            text === "failed" || reason === "busy" ? (
              <Button size="md" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            ) : (
              download
            )
          }
          title={
            reason === "missing" && onComputer(file)
              ? "This file is no longer on the computer"
              : reason && reason in TEXT_REASONS
                ? TEXT_REASONS[reason as keyof typeof TEXT_REASONS]
                : "Can't show this file"
          }
        >
          {reason !== "computer_off" &&
            reason !== "busy" &&
            "Download the file to open it in another app."}
        </ViewerMessage>
      </>
    );
  return <TextBody name={name} format={format} reply={text} choice={choice} />;
}

// Loaded text as the file means it. Also shows a step's output, which has no file of its own.
export function TextBody({
  name,
  format,
  reply,
  choice,
  copy = true,
  label = `Contents of ${name}`,
}: {
  name: string;
  format: TextFormat;
  reply: Extract<TextFileReply, { kind: "text" }>;
  choice?: ViewChoice;
  copy?: boolean;
  label?: string;
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
  const end = copy && <OutputCopy text={joined} label="Copy" />;
  if (format === "markdown")
    return (
      <MarkdownView key={name} name={name} text={joined} note={note} choice={choice} end={end} />
    );
  const tree = !!json && (choice ? choice.value === "rendered" : true);
  return (
    <>
      <ViewerBar note={note} end={end}>
        <ViewSwitch choice={choice} without={format === "json" && !json ? "rendered" : undefined} />
        {!tree && (
          <Switch
            className="viewer-wrap"
            label="Wrap lines"
            checked={wrap}
            onCheckedChange={setWrap}
          />
        )}
      </ViewerBar>
      <div ref={scroller} className="viewer-stage viewer-text">
        {json && tree ? (
          <JsonTree value={json.value} label={label} />
        ) : (
          <CodeLines
            lines={lines}
            name={format === "json" ? "a.json" : name}
            wrap={wrap}
            numbered={reply.from === "start"}
            label={label}
          />
        )}
      </div>
    </>
  );
}
