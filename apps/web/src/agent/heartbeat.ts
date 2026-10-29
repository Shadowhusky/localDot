import { useEffect, useReducer } from "react";
import { liveState } from "../session/status.ts";
import type { AgentSessionView } from "./useAgentSession.ts";

// When the task counts as gone quiet, while all else about it says it is at work: 1.5 s after its
// last heartbeat (performance.now() ms).
function quietAt(agent: AgentSessionView): number | null {
  const beat = agent.model.lastHeartbeat;
  return agent.fresh &&
    agent.snapshot?.status === "running" &&
    beat?.ongoing &&
    beat.receivedAt !== undefined &&
    !agent.snapshot.approval &&
    !agent.snapshot.pause &&
    !agent.model.approval &&
    !(agent.model.safetyPaused?.paused || agent.model.safetyPause) &&
    !agent.model.pendingAsk &&
    !agent.model.pendingTakeover &&
    !agent.model.ended &&
    ["acting", "thinking"].includes(liveState(agent.model) ?? "")
    ? beat.receivedAt + 1500
    : null;
}

export function taskStalled(agent: AgentSessionView, now: number): boolean {
  const at = quietAt(agent);
  return at !== null && now > at;
}

// The same, drawn again when that moment comes rather than looked at on a timer.
export function useTaskStalled(agent: AgentSessionView, watching: boolean): boolean {
  const at = watching ? quietAt(agent) : null;
  const [looks, look] = useReducer((n: number) => n + 1, 0);
  const stalled = at !== null && performance.now() > at;
  useEffect(() => {
    if (at === null || stalled || looks < 0) return;
    const timer = setTimeout(look, at - performance.now() + 1);
    return () => clearTimeout(timer);
  }, [at, stalled, looks]);
  return stalled;
}
