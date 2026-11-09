import { type RefObject, useEffect, useState } from "react";
import { dropConversations, holdConversations } from "../agent/conversation-list.ts";
import { deleteConversations, removalProblem } from "../agent/conversation-selection.ts";
import { count } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { announce } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { canFocus } from "../ui/focus.ts";
import { landingAfter, popConversations } from "./conversation-leave.ts";

export interface DeleteConversationDialogProps {
  api: ApiClient;
  // The conversations to delete, each by its latest task and all its tasks; null while none is
  // asked.
  conversations: readonly { sessionId: string; sessions: readonly string[] }[] | null;
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  // As soon as the daemon has deleted them.
  onDeleted?(sessions: readonly string[]): void;
  // Once their rows have played out and left the lists.
  onRowsGone?(sessions: readonly string[]): void;
}

// Asks before conversations and everything they recorded go for good. The daemon refuses one while
// any of its tasks is under way; that one, or one that couldn't go, stays and the confirmation stays
// open to say so. Nothing moves until the daemon has answered: the confirmation's busy button covers
// the wait, and a dot that burst can't come back, so only those truly gone ever do. The lists hold
// their rows meanwhile, as a read could take one away before it had played out.
export function DeleteConversationDialog({
  api,
  conversations,
  anchor,
  onClose,
  onDeleted,
  onRowsGone,
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
    const letGo = holdConversations(api);
    const result = await deleteConversations(
      api,
      conversations.map((conversation) => conversation.sessionId),
    );
    setBusy(false);
    const gone = conversations.filter((each) => result.deleted.includes(each.sessionId));
    const stays = result.live.length > 0 || result.failed.length > 0;
    if (gone.length === 0) letGo();
    else {
      const ids = gone.map((each) => each.sessionId);
      const sessions = gone.flatMap((each) => each.sessions);
      const land = landingAfter(ids);
      if (!stays && !outsideRows(anchor.current, ids)) anchor.current = land();
      onDeleted?.(sessions);
      popConversations(
        ids,
        () => {
          dropConversations(api, ids);
          onRowsGone?.(sessions);
          letGo();
        },
        {
          land,
          under: stays ? document.querySelector('.ui-layer[data-kind="dialog"]') : null,
        },
      );
    }
    if (stays) setError(removalProblem(result));
    else {
      announce("conversation", `Deleted ${count(n, "conversation", "conversations")}.`);
      onClose();
    }
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

// Whether focus can go back to what asked once these conversations have gone.
function outsideRows(anchor: HTMLElement | null, ids: readonly string[]): boolean {
  const row = anchor?.closest<HTMLElement>("[data-conversation]");
  return canFocus(anchor) && !(row && ids.includes(row.dataset.conversation ?? ""));
}
