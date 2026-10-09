import { useEffect, useRef } from "react";
import { dismissToast, showToast } from "../ui/Toast.tsx";
import type { ControlStatus } from "./useTaskControls.ts";

const TOAST = "task-control";

// A control's progress hangs from the island as a toast: one that settles within a moment shows
// nothing, and one that can't be confirmed stays until it is dealt with.
export function useControlToast(status: ControlStatus | null, recheck: () => void) {
  const message = status?.message;
  const phase = status?.phase;
  const latest = useRef(recheck);
  latest.current = recheck;
  useEffect(() => {
    if (!message || !phase) {
      dismissToast(TOAST);
      return;
    }
    showToast({
      id: TOAST,
      title: message,
      tone: phase === "refused" || phase === "uncertain" ? "danger" : "neutral",
      action:
        phase === "sending"
          ? undefined
          : { label: "Check task state", onAction: () => latest.current() },
    });
  }, [message, phase]);
  useEffect(() => () => dismissToast(TOAST), []);
}
