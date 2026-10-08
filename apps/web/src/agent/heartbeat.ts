import { liveState } from "../session/task-hud.ts";
import type { AgentSessionView } from "./useAgentSession.ts";
export function taskStalled(agent: AgentSessionView, now: number): boolean {
  const beat = agent.model.lastHeartbeat;
  return !!(
    agent.fresh &&
    agent.snapshot?.status === "running" &&
    beat?.ongoing &&
    beat.receivedAt !== undefined &&
    now - beat.receivedAt > 1500 &&
    !agent.snapshot.approval &&
    !agent.snapshot.pause &&
    !agent.model.approval &&
    !(agent.model.safetyPaused?.paused || agent.model.safetyPause) &&
    !agent.model.pendingAsk &&
    !agent.model.pendingTakeover &&
    !agent.model.ended &&
    ["acting", "thinking"].includes(liveState(agent.model) ?? "")
  );
}
