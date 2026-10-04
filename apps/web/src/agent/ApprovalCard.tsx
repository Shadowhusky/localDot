import {
  type ApprovalAnswer,
  type ApprovalCard as Card,
  ApprovalCard as CardSchema,
} from "@localdot/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
export function ApprovalCard({
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
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (visible && enabled && !document.hidden) heading.current?.focus({ preventScroll: true });
  }, [enabled, visible]);
  if (!value.success)
    return <p role="alert">This decision could not be verified. Check task status again.</p>;
  const expired = now >= value.data.expiresAt;
  const decide = (decision: ApprovalAnswer["decision"]) => {
    if (!visible || !enabled || pending || Date.now() >= value.data.expiresAt) return;
    void onDecision({
      approvalId: value.data.approvalId,
      generation: value.data.generation,
      revision: value.data.revision,
      decision,
    });
  };
  return createPortal(
    <div className="approval-overlay" hidden={!visible}>
      <section
        className="approval-card"
        role="dialog"
        aria-modal="false"
        aria-labelledby={`approval-${value.data.approvalId}`}
      >
        <div className="approval-content">
          <p className="safety-eyebrow">Your decision · {value.data.risk} impact</p>
          <h2 ref={heading} tabIndex={-1} id={`approval-${value.data.approvalId}`}>
            {value.data.title}
          </h2>
          <dl>
            {value.data.fields.map(([label, text], index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: these are immutable text rows within one approval identity, with no field state.
              <div key={index}>
                <dt>{label}</dt>
                <dd>{text}</dd>
              </div>
            ))}
          </dl>
          {children}
        </div>
        <div className="approval-footer">
          <p role="status">
            {expired
              ? "This decision has expired. Check task status for the current request."
              : pending
                ? "Checking your decision with the computer…"
                : "Approve this action once, decline it, or take control yourself."}
          </p>
          <div className="safety-actions">
            <button
              type="button"
              disabled={!visible || !enabled || pending || expired}
              onClick={() => decide("approve")}
            >
              Approve once
            </button>
            <button
              type="button"
              disabled={!visible || !enabled || pending || expired}
              onClick={() => decide("deny")}
            >
              Deny
            </button>
            <button
              type="button"
              disabled={!visible || !enabled || pending || expired}
              onClick={() => decide("take_control")}
            >
              Take control
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
