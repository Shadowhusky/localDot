import { useMemo } from "react";
import { Disclosure } from "../ui/Disclosure.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { VirtualList } from "../ui/VirtualList.tsx";
import type { AgentChild } from "./model.ts";
import { SafeMarkdown } from "./SafeMarkdown.tsx";

const key = (child: AgentChild) => child.runId;
const labels = {
  running: "Running",
  completed: "Finished",
  interrupted: "Interrupted",
  failed: "Failed",
};
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
                <StatusGlyph
                  state={
                    child.state === "running"
                      ? "doing"
                      : child.state === "completed"
                        ? "done"
                        : child.state === "failed"
                          ? "failed"
                          : "skipped"
                  }
                />
                <strong>{child.label}</strong>
                <span>{labels[child.state]}</span>
              </div>
              {child.summary && (
                <Disclosure summary="Result">
                  <SafeMarkdown text={child.summary} compact />
                </Disclosure>
              )}
            </section>
          )}
        </VirtualList>
      </div>
    </ScrollArea>
  );
}
