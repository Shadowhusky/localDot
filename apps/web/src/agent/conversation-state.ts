import type { AgentSessionView } from "./useAgentSession.ts";
import { FINISH_FIRST } from "./useConversation.ts";

export function conversationBlockReason(
  agent: AgentSessionView,
  ended: boolean,
  stopping: boolean,
  busy: boolean,
  recoveryWait: boolean,
): string | undefined {
  if (stopping) return "Stopping the current task…";
  if (busy) return "Just a moment…";
  const s = agent.snapshot;
  // An outdated read cannot indefinitely disable navigation. The daemon rechecks ownership
  // for every selection, and briefly waits if a final result's caller is still retiring.
  if (ended || !agent.fresh || !s || s.status === "idle" || s.status === "ended" || recoveryWait)
    return;
  if (
    agent.model.completion &&
    !s.pendingAsk &&
    !s.pendingTakeover &&
    !s.approval &&
    !s.connection &&
    !s.pause &&
    !s.budgetHold &&
    !s.manualControl &&
    !s.holder
  )
    return;
  return FINISH_FIRST;
}
