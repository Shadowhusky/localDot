import {
  type ApprovalAnswer,
  type ApprovalCard as Card,
  ApprovalCard as CardSchema,
} from "@localdot/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlwaysAllow } from "./AlwaysAllow.tsx";

// A program in the computer asked for a connection beyond websites, and it waits for this answer:
// once, for the rest of the task, always for the program or the destination, or not at all.
export function ConnectionCard({
  card,
  onDecision,
  pending,
  enabled = true,
  visible = true,
  children,
}: {
  card: Card;
  onDecision(value: ApprovalAnswer): Promise<boolean> | boolean | undefined;
  pending: boolean;
  enabled?: boolean;
  visible?: boolean;
  children?: ReactNode;
}) {
  const value = CardSchema.safeParse(card);
  const heading = useRef<HTMLHeadingElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (visible && enabled && !document.hidden) heading.current?.focus({ preventScroll: true });
  }, [enabled, visible]);
  if (!value.success || value.data.actionClass !== "network")
    return <p role="alert">This decision could not be verified. Check task status again.</p>;
  const decided = value.data;
  const expired = now >= decided.expiresAt;
  const canAnswer = visible && enabled && !pending && !expired;
  const forTask = decided.always?.some((option) => option.scope === "task");
  const lasting = { ...decided, always: decided.always?.filter((o) => o.scope !== "task") };
  const decide = (decision: ApprovalAnswer["decision"], always?: ApprovalAnswer["always"]) => {
    if (!canAnswer || Date.now() >= decided.expiresAt) return;
    void onDecision({
      approvalId: decided.approvalId,
      generation: decided.generation,
      revision: decided.revision,
      decision,
      ...(always ? { always } : {}),
    });
  };
  return createPortal(
    <div className="approval-overlay" hidden={!visible}>
      <section
        className="approval-card connection-card"
        role="dialog"
        aria-modal="false"
        aria-labelledby={`approval-${decided.approvalId}`}
        aria-describedby={`approval-${decided.approvalId}-why`}
      >
        <div className="approval-content">
          <p className="safety-eyebrow">Your decision · a connection</p>
          <h2 ref={heading} tabIndex={-1} id={`approval-${decided.approvalId}`}>
            {decided.title}
          </h2>
          <p className="connection-why" id={`approval-${decided.approvalId}-why`}>
            Websites open on their own; other connections wait for you. Your Mac and home network
            stay out of reach either way.
          </p>
          <dl>
            {decided.fields.map(([label, text]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <bdi>{text}</bdi>
                </dd>
              </div>
            ))}
          </dl>
          <AlwaysAllow card={lasting} canApprove={canAnswer} onDecision={onDecision} />
          {children}
        </div>
        <div className="approval-footer">
          <p role="status">
            {expired
              ? "This decision has expired. Check task status for the current request."
              : pending
                ? "Checking your decision…"
                : "The program waits until you answer."}
          </p>
          <div className="safety-actions">
            <button type="button" disabled={!canAnswer} onClick={() => decide("approve")}>
              Allow once
            </button>
            {forTask && (
              <button type="button" disabled={!canAnswer} onClick={() => decide("approve", "task")}>
                Allow for this task
              </button>
            )}
            <button type="button" disabled={!canAnswer} onClick={() => decide("deny")}>
              Deny
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
