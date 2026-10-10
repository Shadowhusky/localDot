import type { Ref } from "react";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { SentFiles } from "./Attachments.tsx";
import type { Delivery } from "./Composer.tsx";
import { timeLabel } from "./thread.ts";

// A message on its way, drawn as its own row will be: faint while it is sent, whole once dot has it.
// The row replaces it in place when it arrives, where the copy button takes the spinner's place.
// How it went is said through the page's one polite region, by the composer, not from here.
export function PendingMessage({
  delivery,
  choiceRef,
  onRetry,
  onDismiss,
  onEdit,
  retryReason,
}: {
  delivery: Delivery;
  // Where a lost message offers its two choices.
  choiceRef?: Ref<HTMLDivElement>;
  onRetry(): void;
  onDismiss(): void;
  onEdit(): void;
  retryReason?: string;
}) {
  const { phase } = delivery;
  const started = delivery.request.mode === "new";
  return (
    <div
      className="thread-row thread-pending"
      data-kind="message"
      data-speaker="user"
      data-phase={phase}
    >
      <p className="thread-time">
        <time>{timeLabel(delivery.at)}</time>
      </p>
      <section className="thread-message" data-role="user" aria-label="Message delivery">
        <div className="thread-said">
          <span className="thread-copy-slot thread-pending-slot">
            {phase === "sending" && <Spinner size={12} />}
          </span>
          <p className="thread-bubble">{delivery.draftText}</p>
        </div>
        {delivery.files.length > 0 && <SentFiles names={delivery.files} />}
        {delivery.tag && (phase === "sending" || phase === "accepted") && (
          <div className="thread-queue">
            <p className="thread-tag">{delivery.tag}</p>
            {delivery.request.mode === "followup" && (
              <Button size="sm" variant="quiet" disabledReason="Waiting for the message to arrive.">
                Steer now
              </Button>
            )}
          </div>
        )}
        {phase === "refused" ? (
          <div className="thread-pending-status">
            <p>
              <Icon name="circle-alert" size={12} className="thread-pending-icon" />
              <span>{started ? "Task not started" : "Not sent"}</span>
            </p>
            <Button size="sm" variant="quiet" onClick={onEdit}>
              Edit
            </Button>
          </div>
        ) : (
          phase === "uncertain" && (
            <div className="thread-pending-status" ref={choiceRef}>
              <p>
                <Icon name="circle-alert" size={12} className="thread-pending-icon" />
                <span>
                  Not sure dot got that.
                  <br />
                  Sending again could repeat it.
                </span>
              </p>
              <div className="thread-pending-actions">
                <Button size="sm" disabledReason={retryReason} onClick={onRetry}>
                  Send again
                </Button>
                <Button size="sm" variant="quiet" onClick={onDismiss}>
                  Keep as draft
                </Button>
              </div>
            </div>
          )
        )}
      </section>
    </div>
  );
}
