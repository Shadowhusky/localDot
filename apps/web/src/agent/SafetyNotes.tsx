import { useEffect, useRef } from "react";
import { dismissToast, showToast } from "../ui/Toast.tsx";
import { AllowedNotice } from "./AllowedNotice.tsx";
import type { AgentSessionView } from "./useAgentSession.ts";
import type { SafetyView } from "./useSafety.ts";

const ERROR_TOAST = "safety-error";

// The safety notes that drop from the island: what an Always allow choice now allows, and, as a
// toast, a decision the computer could not take.
export function SafetyNotes({
  safety,
  agent,
  visible = true,
}: {
  safety: SafetyView;
  agent: AgentSessionView;
  visible?: boolean;
}) {
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
