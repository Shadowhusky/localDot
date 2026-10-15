import "../shell/conversation.css";
import { Profiler, useMemo, useRef, useState } from "react";
import { LiveWorkLine } from "../agent/LiveWorkLine.tsx";
import { type AgentStep, emptyAgentModel } from "../agent/model.ts";
import { workSteps } from "../agent/thread.ts";
import { createApi } from "../lib/api.ts";
import { ActivityRail } from "../shell/ActivityRail.tsx";
import { Button } from "../ui/Button.tsx";

const api = createApi("fixture", { origin: "http://localhost" });
export function ActivityPage() {
  const [chat, setChat] = useState(false);
  const [shown, setShown] = useState(false);
  const [count, setCount] = useState(3000);
  const metrics = useRef<HTMLOutputElement>(null);
  const peak = useRef(0);
  const model = useMemo(() => {
    const steps = new Map<string, AgentStep>();
    for (let i = 0; i < count; i++) {
      const read = i % 16 < 14;
      const current = i === count - 1;
      const failed = i % 64 === 62;
      steps.set(`step-${i}`, {
        id: `step-${i}`,
        kind: read ? "file" : "shell",
        startedAt: i * 1_000_000,
        ...(!current
          ? {
              endedAt: i * 1_000_000 + 500_000,
              status: failed ? ("failed" as const) : ("ok" as const),
            }
          : {}),
        intent: read ? undefined : failed ? "Checking the preview" : "Verifying the exported video",
        tool: {
          name: read ? "files" : "shell",
          title: read ? `read /config/project/reference-${i}.md` : "Run export checks",
          ok: !failed,
        },
        note: failed ? "Preview was unavailable." : undefined,
        output: [],
        outputTruncated: false,
      });
    }
    return { ...emptyAgentModel(), steps };
  }, [count]);
  const chatSteps = useMemo(() => workSteps([], model), [model]);
  return (
    <>
      <p>
        Stress fixture: {count.toLocaleString()} recorded steps, including read groups, failures and
        a live action.
      </p>
      <div
        style={{
          display: "flex",
          gap: "calc(var(--spacing) * 2)",
          flexWrap: "wrap",
          marginBottom: "calc(var(--spacing) * 3)",
        }}
      >
        <Button onClick={() => setShown(!shown)}>
          {shown ? "Close activity" : "Open activity"}
        </Button>
        <Button onClick={() => setCount(count + 100)}>Append 100 steps</Button>
        <Button onClick={() => setChat(!chat)}>
          {chat ? "Show Activity panel" : "Show Chat steps"}
        </Button>
        <output ref={metrics} aria-label="Render duration" />
      </div>
      {shown && (
        <div
          style={{
            width: "min(100%, 400px)",
            height: "min(680px, 75vh)",
            display: "flex",
            alignItems: chat ? "flex-start" : "stretch",
            border: "1px solid var(--color-line)",
            borderRadius: "var(--radius-lg)",
            padding: "calc(var(--spacing) * 4)",
          }}
        >
          <Profiler
            id="activity"
            onRender={(_id, phase, duration) => {
              peak.current = Math.max(peak.current, duration);
              if (metrics.current)
                metrics.current.textContent = `${phase}: ${duration.toFixed(1)} ms; peak ${peak.current.toFixed(1)} ms (React render)`;
            }}
          >
            {chat ? (
              <LiveWorkLine
                steps={chatSteps}
                startMs={0}
                live={{ phase: "running", label: "Checking the preview", nowMs: count * 1000 }}
              />
            ) : (
              <ActivityRail
                rows={[]}
                agent={model}
                api={api}
                sessionId="activity-stress"
                scale={1}
                nowMs={count * 1000}
              />
            )}
          </Profiler>
        </div>
      )}
    </>
  );
}
