import { type RefObject, useEffect, useState } from "react";
import { readConversationsAgain } from "../agent/conversation-list.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";

export interface DeleteConversationDialogProps {
  api: ApiClient;
  // The conversation to delete, by its latest task and all its tasks; null while none is asked.
  conversation: { sessionId: string; sessions: readonly string[] } | null;
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  onDeleted?(sessions: readonly string[]): void;
}

// Asks before a conversation and everything it recorded go for good. The daemon refuses while one
// of its tasks is under way.
export function DeleteConversationDialog({
  api,
  conversation,
  anchor,
  onClose,
  onDeleted,
}: DeleteConversationDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = conversation?.sessionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: another conversation asked is the trigger.
  useEffect(() => setError(null), [asked]);
  const remove = async () => {
    if (!conversation || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/conversations/${conversation.sessionId}`);
      onDeleted?.(conversation.sessions);
      onClose();
      readConversationsAgain(api);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? "Stop this conversation's task before deleting it."
          : "The conversation couldn't be deleted. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={conversation !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      anchor={anchor}
      title="Delete this conversation?"
      description={
        error ? (
          <span role="alert">{error}</span>
        ) : (
          "Its messages, recordings and screenshots will be removed. This can't be undone."
        )
      }
    >
      <Button variant="quiet" disabledReason={busy ? "Deleting…" : undefined} onClick={onClose}>
        Cancel
      </Button>
      <Button variant="destructive" busy={busy} onClick={() => void remove()}>
        Delete
      </Button>
    </Dialog>
  );
}
