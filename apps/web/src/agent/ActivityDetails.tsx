import { useEffect, useRef, useState } from "react";
import { DiffViewer } from "./DiffViewer.tsx";
import type { AgentModel } from "./model.ts";
import { TerminalViewer } from "./TerminalViewer.tsx";
import "./output.css";

type Choice = { owner: string; kind: "terminal" | "diff"; id: string };
export function ActivityDetails({
  model,
  sessionId,
}: {
  model: AgentModel;
  sessionId: string | null;
}) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const origin = useRef<HTMLButtonElement | null>(null),
    panel = useRef<HTMLElement | null>(null);
  const active = choice?.owner === sessionId ? choice : null;
  const step = active?.kind === "terminal" ? model.steps.get(active.id) : undefined;
  const change =
    active?.kind === "diff" ? model.changes.find((row) => row.id === active.id) : undefined;
  const tools = [...model.steps.values()].filter(
    (row) => row.tool || row.terminal || row.outputTruncated,
  );
  useEffect(() => {
    if (active) panel.current?.focus();
  }, [active]);
  const show = (kind: Choice["kind"], id: string, trigger: HTMLButtonElement) => {
    if (!sessionId) return;
    origin.current = trigger;
    setChoice({ owner: sessionId, kind, id });
  };
  const close = () => {
    setChoice(null);
    if (origin.current?.isConnected) origin.current.focus();
  };
  return (
    <div className="activity-details">
      {model.activity && (
        <details className="model-activity">
          <summary>Model activity</summary>
          <p>{model.activity}</p>
        </details>
      )}
      {!!tools.length && (
        <section aria-label="Output previews">
          <h3>Command output</h3>
          {tools.map((row) => (
            <button
              type="button"
              key={row.id}
              onClick={(event) => show("terminal", row.id, event.currentTarget)}
            >
              Inspect {row.tool?.title ?? "command output"}
            </button>
          ))}
        </section>
      )}
      {!!model.changes.length && (
        <section aria-label="Change previews">
          <h3>Changes</h3>
          {model.changes.map((row) => (
            <button
              type="button"
              key={row.id}
              onClick={(event) => show("diff", row.id, event.currentTarget)}
            >
              {row.type === "memory" ? "Memory" : (row.op ?? "Change")}: {row.path.slice(0, 1024)}
            </button>
          ))}
        </section>
      )}
      {active && (
        <section className="output-detail" ref={panel} tabIndex={-1} aria-label="Selected output">
          <button type="button" onClick={close}>
            Close output
          </button>
          {step ? (
            <TerminalViewer step={step} />
          ) : change ? (
            <DiffViewer change={change} />
          ) : (
            <p>
              This preview is no longer in recent activity. Earlier history remains in the task log.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
