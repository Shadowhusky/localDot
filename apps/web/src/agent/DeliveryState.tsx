import type { Delivery } from "./Composer.tsx";

export function DeliveryState({
  delivery,
  onInspect,
  onRetry,
  onDismiss,
  retryEnabled,
}: {
  delivery: Delivery | null;
  onInspect(): void;
  onRetry(): void;
  onDismiss(): void;
  retryEnabled: boolean;
}) {
  if (!delivery) return null;
  return (
    <section className="delivery-state" aria-label="Message delivery" role="status">
      <p>
        {delivery.phase === "sending"
          ? "Sending to the daemon…"
          : delivery.phase === "accepted"
            ? "Accepted by the daemon."
            : delivery.explanation}
      </p>
      {delivery.phase === "uncertain" && (
        <>
          <p>Check the conversation before retrying. Resending may create a duplicate.</p>
          <button type="button" onClick={onInspect}>
            Check current task
          </button>
          <button type="button" disabled={!retryEnabled} onClick={onRetry}>
            Resend once, risking a duplicate
          </button>
          <button type="button" onClick={onDismiss}>
            Keep draft and stop retrying
          </button>
        </>
      )}
    </section>
  );
}
