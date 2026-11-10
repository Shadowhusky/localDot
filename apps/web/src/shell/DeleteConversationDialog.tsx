import type { RefObject } from "react";
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
  // As soon as they are confirmed, while the daemon deletes them.
  onDeleted?(sessions: readonly string[]): void;
  // Once their rows have played out and left the lists.
  onRowsGone?(sessions: readonly string[]): void;
}

// Asks before conversations and everything they recorded go for good. Once confirmed they leave at
// once, each dot bursting, while the daemon deletes them behind; the lists hold their rows meanwhile,
// so no read brings one back half-way, and read again once it is done. The daemon refuses one while
// any of its tasks is under way, which the list doesn't offer; one it refused or couldn't delete
// comes back with that read, and a note says so.
export function DeleteConversationDialog({
  api,
  conversations,
  anchor,
  onClose,
  onDeleted,
  onRowsGone,
}: DeleteConversationDialogProps) {
  const n = conversations?.length ?? 0;
  const remove = () => {
    if (!conversations) return;
    const ids = conversations.map((conversation) => conversation.sessionId);
    const sessions = conversations.flatMap((conversation) => conversation.sessions);
    const letGo = holdConversations(api);
    let rowsGone = false;
    let settled = false;
    const finish = () => {
      if (rowsGone && settled) letGo();
    };
    const land = landingAfter(ids);
    if (!outsideRows(anchor.current, ids)) anchor.current = land();
    onDeleted?.(sessions);
    onClose();
    popConversations(
      ids,
      () => {
        dropConversations(api, ids);
        onRowsGone?.(sessions);
        rowsGone = true;
        finish();
      },
      { land },
    );
    void deleteConversations(api, ids).then((result) => {
      settled = true;
      finish();
      if (result.live.length > 0 || result.failed.length > 0)
        announce("conversation", removalProblem(result), "assertive");
      else announce("conversation", `Deleted ${count(n, "conversation", "conversations")}.`);
    });
  };
  return (
    <Dialog
      open={conversations !== null}
      onClose={onClose}
      anchor={anchor}
      title={n > 1 ? `Delete ${n.toLocaleString()} conversations?` : "Delete this conversation?"}
      description={
        n > 1
          ? "Their messages, recordings and screenshots will be removed. This can't be undone."
          : "Its messages, recordings and screenshots will be removed. This can't be undone."
      }
    >
      <Button variant="quiet" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="destructive" onClick={remove}>
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
