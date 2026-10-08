import { useEffect, useRef, useState } from "react";
import type { CellSummary } from "../cells/types.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { notifyApproval } from "./approval-notification.ts";
import { taskStalled } from "./heartbeat.ts";
import type { AgentSessionView } from "./useAgentSession.ts";
import type { SafetyView } from "./useSafety.ts";
import "./safety.css";
export function SafetyControls({
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
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [permission, setPermission] = useState(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!safety.approval || !safety.canNotify || !agent.sessionId || permission !== "granted")
      return;
    const error = notifyApproval(
      safety.approval,
      `${cell?.id}:${agent.sessionId}`,
      seen.current,
      () => {
        window.focus();
        document
          .getElementById(`approval-${safety.approval?.approvalId}`)
          ?.focus({ preventScroll: false });
      },
    );
    if (error) setNotificationError(error);
  }, [safety.approval, safety.canNotify, agent.sessionId, cell?.id, permission]);
  const enable = async () => {
    if (typeof Notification === "undefined") {
      setNotificationError("Notifications are not supported here.");
      return;
    }
    try {
      const value = await Notification.requestPermission();
      setPermission(value);
      setNotificationError(
        value === "denied"
          ? "Notifications are blocked in this browser. Decisions remain visible in the app."
          : null,
      );
    } catch {
      setNotificationError(
        "Notification permission could not be changed. Decisions remain visible in the app.",
      );
    }
  };
  const pause = safety.pause;
  return (
    <div className="safety-controls">
      {safety.approval && (
        <ApprovalCard
          key={`${safety.approval.approvalId}:${safety.approval.generation}:${safety.approval.revision}`}
          card={safety.approval}
          enabled={visible && safety.canApprove}
          visible={visible}
          pending={safety.pending === "approval"}
          onDecision={safety.answerApproval}
        >
          <div className="notification-control">
            <button
              type="button"
              disabled={permission === "granted" || permission === "unsupported" || !visible}
              onClick={() => void enable()}
            >
              {permission === "granted" ? "Notifications enabled" : "Enable decision notifications"}
            </button>
            {notificationError && <p role="status">{notificationError}</p>}
          </div>
        </ApprovalCard>
      )}
      {!replaying && !!agent.sessionId && agent.snapshot?.status !== "ended" && (
        <div className="safety-task-controls">
          {pause ? (
            <>
              <p role="status">
                {pause.phase === "paused"
                  ? "Paused at the next step. Your task and files are retained."
                  : pause.phase === "uncertain"
                    ? "Pause is unconfirmed. Resume is unavailable; use Stop to contain the computer."
                    : pause.phase === "resuming"
                      ? "Resuming — checking task status…"
                      : "Pausing after the current step. Its output can finish; the next step is held."}
              </p>
              <button
                type="button"
                disabled={!safety.canResume || !visible}
                onClick={() => void safety.resume()}
              >
                Resume task
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!safety.canPause || !visible}
              onClick={() => void safety.requestPause()}
            >
              Pause after this step
            </button>
          )}
          <span className="stop-hint">Stop: Ctrl/Cmd + Shift + .</span>
        </div>
      )}
      {!replaying && taskStalled(agent, now) && (
        <p role="status">The task heartbeat is late. You can use Stop if you want to contain it.</p>
      )}
      {cell?.fenced && (
        <section className="fenced-recovery" aria-label="Computer recovery">
          <h2>This computer is unavailable</h2>
          <p>
            An earlier action could not be safely confirmed. Its old Downloads volume is retained
            for recovery. Replacement uses a fresh computer and home.
          </p>
          <button
            type="button"
            disabled={!safety.canReplace || !visible}
            onClick={() => void safety.replace()}
          >
            {safety.replacing ? "Verifying replacement…" : "Replace computer"}
          </button>
          {safety.replacement && (
            <p role="status">
              {safety.replacement.phase === "blocked"
                ? "Replacement could not be verified. The old computer stays unavailable."
                : safety.replacement.phase === "ready"
                  ? "The fresh computer is verified. Loading it…"
                  : "Retiring the old computer and verifying a fresh one…"}
            </p>
          )}
        </section>
      )}
      {safety.error && (
        <div role="alert">
          <p>{safety.error}</p>
          <button type="button" onClick={safety.checkAgain}>
            Check task status
          </button>
        </div>
      )}
    </div>
  );
}
