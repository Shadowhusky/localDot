import type { SubagentStop } from "@localdot/protocol";
import { useMemo } from "react";
import { Disclosure } from "../ui/Disclosure.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { VirtualList } from "../ui/VirtualList.tsx";
import type { AgentChild, AgentRun } from "./model.ts";
import { SafeMarkdown } from "./SafeMarkdown.tsx";

const key = (child: AgentChild) => child.id;
const labels = {
  running: "Running",
  completed: "Finished",
  interrupted: "Interrupted",
  failed: "Failed",
};
const reasons: Record<SubagentStop, string> = {
  limit: "Usage limit reached",
  error: "Stopped by an error",
  restarted: "localDot restarted",
  control: "You took the computer",
  stopped: "Task stopped",
  cancelled: "Stopped by dot",
};
const label = (run: Pick<AgentRun, "state" | "resumed">) =>
  run.state === "running" && run.resumed ? "Resumed" : labels[run.state];
const glyph = (state: AgentRun["state"]) =>
  state === "running"
    ? "doing"
    : state === "completed"
      ? "done"
      : state === "failed"
        ? "failed"
        : "skipped";
export function SubagentList({ agents }: { agents: ReadonlyMap<string, AgentChild> }) {
  const children = useMemo(() => [...agents.values()].reverse(), [agents]);
  return (
    <ScrollArea className="activity-scroll" aria-label="Delegated agents" tabIndex={0}>
      <div className="activity-content subagent-list">
        {!children.length && (
          <p className="activity-empty">Delegated agents appear here when dot starts them.</p>
        )}
        <VirtualList items={children} itemKey={key}>
          {(child) => (
            <section className="subagent-row">
              <div className="subagent-heading">
                <StatusGlyph state={glyph(child.state)} />
                <strong>{child.label}</strong>
                <span>{label(child)}</span>
              </div>
              {child.reason && <p className="subagent-reason">{reasons[child.reason]}</p>}
              {child.summary && (
                <Disclosure summary="Result">
                  <SafeMarkdown text={child.summary} compact />
                </Disclosure>
              )}
              {child.earlier.length > 0 && (
                <Disclosure summary="Earlier runs" meta={child.earlier.length}>
                  <ol className="subagent-runs">
                    {child.earlier.map((run) => (
                      <li key={run.runId}>
                        <div className="subagent-run-heading">
                          <StatusGlyph state={glyph(run.state)} />
                          <span>
                            {label(run)}
                            {run.reason && ` · ${reasons[run.reason]}`}
                          </span>
                        </div>
                        {run.summary && <SafeMarkdown text={run.summary} compact />}
                      </li>
                    ))}
                  </ol>
                </Disclosure>
              )}
            </section>
          )}
        </VirtualList>
      </div>
    </ScrollArea>
  );
}
