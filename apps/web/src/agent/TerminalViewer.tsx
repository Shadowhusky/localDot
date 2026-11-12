import { type ReactNode, useMemo } from "react";
import { t, tr } from "../i18n/index.ts";
import { PreviewChips } from "../previews/PreviewChip.tsx";
import { Badge } from "../ui/Badge.tsx";
import type { AgentStep } from "./model.ts";
import { OutputCopy } from "./OutputCopy.tsx";
import { StepFileResources, StepPreviewButton } from "./StepPreview.tsx";
import { emptyTerminal, terminalDisplayed } from "./terminal-text.ts";
import "./output.css";

const STREAMS = {
  stdout: {
    name: tr("Output"),
    preview: tr("Preview output"),
    region: tr("Standard output text"),
    copy: tr("Copy output"),
  },
  stderr: {
    name: tr("Errors"),
    preview: tr("Preview errors"),
    region: tr("Standard error text"),
    copy: tr("Copy errors"),
  },
};
// A command that succeeded still writes warnings and notes to its error stream.
const NOTES = {
  ...STREAMS.stderr,
  name: tr("Messages"),
  preview: tr("Preview messages"),
  copy: tr("Copy messages"),
};

export function TerminalViewer({ step, children }: { step: AgentStep; children?: ReactNode }) {
  const display = useMemo(() => {
    const terminal = step.terminal ?? emptyTerminal();
    return {
      stdout: terminalDisplayed(terminal, "stdout"),
      stderr: terminalDisplayed(terminal, "stderr"),
      terminal,
    };
  }, [step.terminal]);
  const shortened = display.stdout.truncated || display.stderr.truncated || step.outputTruncated;
  const exit = step.tool?.exitCode;
  const notes = [
    shortened && t`Shortened to the kept text.`,
    display.terminal.controlsRemoved && t`Terminal control codes removed.`,
    display.terminal.nonprintable && t`Binary output left out.`,
  ].filter(Boolean);
  const streams = (["stdout", "stderr"] as const).filter((stream) => display[stream].text);
  const failed = step.tool?.ok === false || (exit !== undefined && exit !== 0);
  // A step that brought back pictures only captions them here: it opens as the pictures, not as
  // the words under them.
  const captions = (step.images?.length ?? 0) > 0;
  const named = (stream: "stdout" | "stderr") =>
    stream === "stderr" && !failed ? NOTES : STREAMS[stream];
  return (
    <section className="terminal-viewer" aria-label={t`Command output`}>
      <div className="terminal-well">
        {streams.map((stream) => (
          <section
            key={stream}
            className="terminal-stream step-preview-resource"
            data-stream={stream}
            data-failed={failed || undefined}
            aria-label={named(stream).name}
          >
            {!captions && (
              <StepPreviewButton
                label={named(stream).preview}
                resource={{ kind: "text", name: named(stream).name, text: display[stream].text }}
              />
            )}
            <h4 className="terminal-stream-name">{named(stream).name}</h4>
            <section className="terminal-text" aria-label={named(stream).region}>
              <pre>{display[stream].text}</pre>
            </section>
          </section>
        ))}
        <StepFileResources
          text={[step.tool?.title, display.stdout.text, display.stderr.text]
            .filter(Boolean)
            .join("\n")}
        />
        <PreviewChips text={`${display.stdout.text}\n${display.stderr.text}`} />
        {children}
        {!streams.length && !children && <p className="terminal-empty">{t`No output.`}</p>}
      </div>
      <div className="terminal-foot">
        {exit !== undefined && (
          <Badge tone={exit === 0 ? "neutral" : "danger"}>{t`Exit ${exit}`}</Badge>
        )}
        {notes.length > 0 && <span className="terminal-notes">{notes.join(" ")}</span>}
        {streams.map((stream) => (
          <OutputCopy key={stream} text={display[stream].text} label={named(stream).copy} />
        ))}
      </div>
    </section>
  );
}
