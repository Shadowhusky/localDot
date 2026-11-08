import { type RefObject, useEffect, useState } from "react";
import { readConversationsAgain } from "../agent/conversation-list.ts";
import { deleteConversations, removalProblem } from "../agent/conversation-selection.ts";
import { count } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { announce } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";

export interface DeleteConversationDialogProps {
  api: ApiClient;
  // The conversations to delete, each by its latest task and all its tasks; null while none is
  // asked.
  conversations: readonly { sessionId: string; sessions: readonly string[] }[] | null;
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  onDeleted?(sessions: readonly string[]): void;
}

// Asks before conversations and everything they recorded go for good. The daemon refuses one while
// any of its tasks is under way; that one, or one that couldn't go, stays and the confirmation stays
// open to say so.
export function DeleteConversationDialog({
  api,
  conversations,
  anchor,
  onClose,
  onDeleted,
}: DeleteConversationDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = conversations?.map((conversation) => conversation.sessionId).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: others asked are the trigger.
  useEffect(() => setError(null), [asked]);
  const n = conversations?.length ?? 0;
  const remove = async () => {
    if (!conversations || busy) return;
    setBusy(true);
    setError(null);
    const result = await deleteConversations(
      api,
      conversations.map((conversation) => conversation.sessionId),
    );
    setBusy(false);
    const gone = conversations.filter((each) => result.deleted.includes(each.sessionId));
    if (gone.length > 0) onDeleted?.(gone.flatMap((each) => each.sessions));
    if (result.live.length > 0 || result.failed.length > 0) setError(removalProblem(result));
    else {
      if (n > 1) announce("conversation", `Deleted ${count(n, "conversation", "conversations")}.`);
      onClose();
    }
    if (gone.length > 0) readConversationsAgain(api);
  };
  return (
    <Dialog
      open={conversations !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      anchor={anchor}
      title={n > 1 ? `Delete ${n.toLocaleString()} conversations?` : "Delete this conversation?"}
      description={
        error ? (
          <span role="alert">{error}</span>
        ) : n > 1 ? (
          "Their messages, recordings and screenshots will be removed. This can't be undone."
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
