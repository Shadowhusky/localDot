// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Named scroll regions require keyboard focus so long output can be scrolled.
import { useMemo } from "react";
import type { AgentStep } from "./model.ts";
import { OutputCopy } from "./OutputCopy.tsx";
import { emptyTerminal, terminalDisplayed } from "./terminal-text.ts";
import "./output.css";
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
  return (
    <section className="terminal-viewer" aria-label="Command output">
      <h3>{step.tool?.title ?? "Command output"}</h3>
      <p className="history-note">Output from this step. This viewer does not accept commands.</p>
      {step.tool?.exitCode !== undefined && <p>Exit code: {step.tool.exitCode}</p>}
      {shortened && (
        <p className="history-note">Output preview shortened. Showing retained text.</p>
      )}
      {display.terminal.controlsRemoved && (
        <p className="history-note">Terminal control sequences removed.</p>
      )}
      {display.terminal.nonprintable && (
        <p className="history-note">Binary or nonprintable output omitted.</p>
      )}
      {(["stdout", "stderr"] as const).map((stream) => (
        <section
          key={stream}
          aria-label={stream === "stdout" ? "Standard output" : "Standard error"}
        >
          <h4>{stream === "stdout" ? "Standard output" : "Standard error"}</h4>
          {display[stream].text ? (
            <>
              <section
                className="terminal-text"
                tabIndex={0}
                aria-label={stream === "stdout" ? "Standard output text" : "Standard error text"}
              >
                <pre>{display[stream].text}</pre>
              </section>
              <OutputCopy text={display[stream].text} label={`Copy ${stream}`} />
            </>
          ) : (
            <p className="history-note">No text output.</p>
          )}
        </section>
      ))}
    </section>
  );
}
