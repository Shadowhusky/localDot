import { useEffect, useRef } from "react";
import type { CellSummary } from "../cells/types.ts";
import { dismissToast, showToast } from "../ui/Toast.tsx";
import { AllowedNotice } from "./AllowedNotice.tsx";
import { notifyApproval } from "./approval-notification.ts";
import type { AgentSessionView } from "./useAgentSession.ts";
import type { SafetyView } from "./useSafety.ts";

const ERROR_TOAST = "safety-error";

// The safety notes that drop from the island: what an Always allow choice now allows, and, as a
// toast, a decision the computer could not take. A granted notification still announces each new
// approval.
export function SafetyNotes({
  safety,
  agent,
  cell,
  visible = true,
}: {
  safety: SafetyView;
  agent: AgentSessionView;
  cell: CellSummary | null;
  visible?: boolean;
}) {
  const seen = useRef(new Set<string>());
  const checkAgain = useRef(safety.checkAgain);
  checkAgain.current = safety.checkAgain;
  useEffect(() => {
    if (!safety.error) {
      dismissToast(ERROR_TOAST);
      return;
    }
    showToast({
      id: ERROR_TOAST,
      title: safety.error,
      tone: "danger",
      action: { label: "Check again", onAction: () => checkAgain.current() },
    });
  }, [safety.error]);
  useEffect(() => () => dismissToast(ERROR_TOAST), []);
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
    <AllowedNotice
      choice={safety.approval ? null : safety.allowed}
      outcome={agent.model.approvalOutcome}
      visible={visible}
      onUndo={() => void safety.undoAllowed()}
      onDismiss={safety.dismissAllowed}
    />
  );
}
