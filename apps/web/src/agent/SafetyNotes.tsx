import { useEffect, useRef, useState } from "react";
import type { CellSummary } from "../cells/types.ts";
import { Button } from "../ui/Button.tsx";
import { AllowedNotice } from "./AllowedNotice.tsx";
import { notifyApproval } from "./approval-notification.ts";
import { taskStalled } from "./heartbeat.ts";
import type { AgentSessionView } from "./useAgentSession.ts";
import type { SafetyView } from "./useSafety.ts";

// The safety notes that drop from the island: what an Always allow choice now allows, a task that
// has gone quiet, and a decision the computer could not take. A granted notification still
// announces each new approval.
export function SafetyNotes({
  safety,
  agent,
  cell,
  visible = true,
  replaying = false,
}: {
  safety: SafetyView;
  agent: AgentSessionView;
  cell: CellSummary | null;
  visible?: boolean;
  replaying?: boolean;
}) {
  const seen = useRef(new Set<string>());
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (
      !safety.approval ||
      !safety.canNotify ||
      !agent.sessionId ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    notifyApproval(safety.approval, `${cell?.id}:${agent.sessionId}`, seen.current, () => {
      window.focus();
      document
        .getElementById(`approval-${safety.approval?.approvalId}`)
        ?.focus({ preventScroll: false });
    });
  }, [safety.approval, safety.canNotify, agent.sessionId, cell?.id]);
  return (
    <>
      <AllowedNotice
        choice={safety.approval ? null : safety.allowed}
        outcome={agent.model.approvalOutcome}
        visible={visible}
        onUndo={() => void safety.undoAllowed()}
        onDismiss={safety.dismissAllowed}
      />
      {taskStalled(agent, now) && (
        <p className="island-note" role="status">
          {replaying
            ? "The live task is taking longer than usual. Switch to Watch to stop it."
            : "dot is taking longer than usual. Use Stop if it seems stuck."}
        </p>
      )}
      {safety.error && (
        <div className="island-note" role="alert">
          <p>{safety.error}</p>
          <Button variant="quiet" size="sm" onClick={safety.checkAgain}>
            Check task status
          </Button>
        </div>
      )}
    </>
  );
}
