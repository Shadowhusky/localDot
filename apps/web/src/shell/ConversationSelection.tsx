import { clsx } from "clsx";
import { useState } from "react";
import type { ConversationRow, Organize } from "../agent/conversation-list.ts";
import { organizeConversations, selectedLabel, underWay } from "../agent/conversation-selection.ts";
import { count } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { announce } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import type { IconName } from "../ui/icons.ts";

// Pressed with Cmd or Ctrl, a row starts selecting rather than opening.
export const adds = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  event.metaKey || event.ctrlKey;

export function SelectAll({
  shown,
  chosen,
  onChange,
  className,
}: {
  shown: number;
  chosen: number;
  onChange(on: boolean): void;
  className?: string;
}) {
  const all = shown > 0 && chosen === shown;
  return (
    <Checkbox
      className={clsx("conversations-select-all", className)}
      label="Select all"
      checked={all}
      indeterminate={!all && chosen > 0}
      onCheckedChange={onChange}
    />
  );
}

export interface SelectionActionsProps {
  api: ApiClient;
  picked: readonly ConversationRow[];
  running(row: ConversationRow): boolean;
  // Icons alone, where the list is narrow.
  compact?: boolean;
  onDelete(): void;
  // Every one chosen was filed.
  onDone(): void;
  className?: string;
}

// What can be done to the chosen conversations together: how many there are, and the actions one
// row's menu has that make sense for several. As one alone, one under way is never archived or
// deleted.
export function SelectionActions({
  api,
  picked,
  running,
  compact = false,
  onDelete,
  onDone,
  className,
}: SelectionActionsProps) {
  const [busy, setBusy] = useState(false);
  const n = picked.length;
  const none = n === 0 ? "Select conversations first." : busy ? "Saving…" : undefined;
  const pin = n === 0 || picked.some((row) => !row.entry.pinned);
  const archive = n === 0 || picked.some((row) => !row.entry.archived);
  const conversations = (k: number) => count(k, "conversation", "conversations");
  const file = async (change: Organize, done: string, undone: string) => {
    setBusy(true);
    const refused = await organizeConversations(
      api,
      picked.map((row) => row.entry.sessionId),
      change,
    );
    setBusy(false);
    if (refused > 0)
      announce(
        "conversation",
        `${conversations(refused)} couldn't be ${undone}. Try again.`,
        "assertive",
      );
    else {
      announce("conversation", `${conversations(n)} ${done}.`);
      onDone();
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of actions, not a form's fieldset.
    <div
      className={clsx("conversations-actions", className)}
      role="group"
      aria-label="Selected conversations"
    >
      <span className="conversations-chosen num">{selectedLabel(n)}</span>
      <span className="conversations-actions-tools">
        <Action
          compact={compact}
          icon={pin ? "pin" : "pin-off"}
          label={pin ? "Pin" : "Unpin"}
          disabledReason={none}
          onClick={() =>
            void (pin
              ? file({ pinned: true }, "pinned", "pinned")
              : file({ pinned: false }, "unpinned", "unpinned"))
          }
        />
        <Action
          compact={compact}
          icon={archive ? "archive" : "archive-restore"}
          label={archive ? "Archive" : "Unarchive"}
          disabledReason={
            none ??
            (archive
              ? underWay(
                  picked.filter((row) => !row.entry.archived),
                  running,
                  "archiving",
                )
              : undefined)
          }
          onClick={() =>
            void (archive
              ? file({ archived: true }, "archived", "archived")
              : file({ archived: false }, "unarchived", "unarchived"))
          }
        />
        <Action
          compact={compact}
          destructive
          icon="trash"
          label="Delete…"
          disabledReason={none ?? underWay(picked, running, "deleting")}
          onClick={onDelete}
        />
      </span>
    </div>
  );
}

function Action({
  compact,
  destructive = false,
  icon,
  label,
  disabledReason,
  onClick,
}: {
  compact: boolean;
  destructive?: boolean;
  icon: IconName;
  label: string;
  disabledReason?: string;
  onClick(): void;
}) {
  return compact ? (
    <IconButton
      icon={icon}
      size={28}
      label={label}
      disabledReason={disabledReason}
      onClick={onClick}
    />
  ) : (
    <Button
      variant={destructive ? "destructive" : "quiet"}
      size="sm"
      icon={icon}
      disabledReason={disabledReason}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
