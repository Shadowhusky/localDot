import { useMemo } from "react";
import { Badge } from "../ui/Badge.tsx";
import type { AgentStep } from "./model.ts";
import { OutputCopy } from "./OutputCopy.tsx";
import { emptyTerminal, terminalDisplayed } from "./terminal-text.ts";
import "./output.css";

const STREAMS = {
  stdout: { name: "Output", region: "Standard output text", copy: "Copy output" },
  stderr: { name: "Errors", region: "Standard error text", copy: "Copy errors" },
} as const;
// A command that succeeded still writes warnings and notes to its error stream.
const NOTES = { ...STREAMS.stderr, name: "Messages", copy: "Copy messages" };

export function TerminalViewer({ step }: { step: AgentStep }) {
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
    shortened && "Shortened to the kept text.",
    display.terminal.controlsRemoved && "Terminal control codes removed.",
    display.terminal.nonprintable && "Binary output left out.",
  ].filter(Boolean);
  const streams = (["stdout", "stderr"] as const).filter((stream) => display[stream].text);
  const failed = step.tool?.ok === false || (exit !== undefined && exit !== 0);
  const named = (stream: "stdout" | "stderr") =>
    stream === "stderr" && !failed ? NOTES : STREAMS[stream];
  return (
    <section className="terminal-viewer" aria-label="Command output">
      <div className="terminal-well">
        {streams.map((stream) => (
          <section
            key={stream}
            className="terminal-stream"
            data-stream={stream}
            data-failed={failed || undefined}
            aria-label={named(stream).name}
          >
            <h4 className="terminal-stream-name">{named(stream).name}</h4>
            <section className="terminal-text" aria-label={named(stream).region}>
              <pre>{display[stream].text}</pre>
            </section>
          </section>
        ))}
        {!streams.length && <p className="terminal-empty">No output.</p>}
      </div>
      <div className="terminal-foot">
        {exit !== undefined && (
          <Badge tone={exit === 0 ? "neutral" : "danger"}>{`Exit ${exit}`}</Badge>
        )}
        {notes.length > 0 && <span className="terminal-notes">{notes.join(" ")}</span>}
        {streams.map((stream) => (
          <OutputCopy key={stream} text={display[stream].text} label={named(stream).copy} />
        ))}
      </div>
    </section>
  );
}
