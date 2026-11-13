import {
  CONVERSATION_NAME_CHARS,
  type ConversationEntry,
  type ConversationTag,
  type TagId,
  type Wearable,
} from "@localdot/protocol";
import { useState } from "react";
import { type Organize, tagIds, toggledTag } from "../agent/conversation-list.ts";
import { DotAvatar } from "../dot/DotAvatar.tsx";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { TagSwatches } from "../ui/ConversationTag.tsx";
import type { IconName } from "../ui/icons.ts";
import { Sheet } from "../ui/Sheet.tsx";
import { TextField } from "../ui/TextField.tsx";

export interface DetailRow {
  label: string;
  icon: IconName;
  note?: string;
  disabledReason?: string;
  run(): void;
}

// What the row's menu does to the conversation, here as well.
export interface DetailActions {
  rows: readonly DetailRow[];
  tag: {
    chosen: readonly TagId[];
    onSelect(tag: ConversationTag | null): void;
    // Its tags among the user's own.
    more: DetailRow;
  };
  // Last, apart: it goes for good.
  remove: DetailRow;
}

// The row menu's actions for the conversation on show (ConversationMenu), but Select, which picks
// among the list's rows.
export function detailActions(
  entry: ConversationEntry,
  {
    working,
    organize,
    dress,
    tag,
    remove,
  }: {
    working: boolean;
    organize(change: Organize): void;
    dress(): void;
    tag(): void;
    remove(): void;
  },
): DetailActions {
  const archived = !!entry.archived;
  return {
    rows: [
      { label: t`Change look`, icon: "smile", run: dress },
      {
        label: entry.pinned ? t`Unpin` : t`Pin to top`,
        icon: entry.pinned ? "pin-off" : "pin",
        run: () => organize({ pinned: !entry.pinned }),
      },
      {
        label: archived ? t`Unarchive` : t`Archive`,
        icon: archived ? "archive-restore" : "archive",
        disabledReason:
          working && !archived ? t`Stop this task before archiving its conversation.` : undefined,
        run: () => organize({ archived: !archived }),
      },
    ],
    tag: {
      chosen: tagIds(entry),
      onSelect: (colour) => organize({ tags: toggledTag(tagIds(entry), colour) }),
      more: { label: t`Tags…`, icon: "tag", run: tag },
    },
    remove: {
      label: t`Delete conversation`,
      icon: "trash",
      disabledReason: working ? t`Stop this task before deleting its conversation.` : undefined,
      run: remove,
    },
  };
}

// A conversation's name opened out: its dot, how it stands, and where to go from here.
export function ConversationDetails({
  open,
  onClose,
  title,
  status,
  look,
  seed,
  rows,
  actions,
  onRename,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  status: string;
  look: readonly Wearable[];
  seed: string;
  rows: readonly DetailRow[];
  // None for a conversation not yet started, or for a shared link's guest.
  actions?: DetailActions;
  // No conversation to name yet, without this.
  onRename?(name: string): void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const finish = () => {
    if (renaming !== null && renaming.trim() !== title) onRename?.(renaming.trim());
    setRenaming(null);
  };
  return (
    <Sheet
      open={open}
      onClose={() => {
        finish();
        onClose();
      }}
      title={t`Details`}
      side="bottom"
      doneLabel={t`Done`}
    >
      <div className="phone-details">
        <div className="phone-details-hero">
          <DotAvatar size={96} wearables={look} seed={seed} />
          {renaming === null ? (
            <strong>{title}</strong>
          ) : (
            <TextField
              aria-label={t`New name`}
              placeholder={t`Automatic name`}
              maxLength={CONVERSATION_NAME_CHARS}
              autoComplete="off"
              enterKeyHint="done"
              autoFocus
              value={renaming}
              onChange={(event) => setRenaming(event.target.value)}
              onBlur={finish}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  finish();
                }
              }}
            />
          )}
          <small className="num">{status}</small>
        </div>
        {onRename && (
          <Button
            variant="quiet"
            icon="type"
            className="phone-details-row"
            onClick={() => setRenaming(title)}
          >
            {t`Rename`}
          </Button>
        )}
        {[...(actions?.rows ?? []), ...rows].map((row) => (
          <DetailButton key={row.label} row={row} onClose={onClose} />
        ))}
        {actions && (
          <>
            <div className="phone-details-tags">
              <TagSwatches standalone chosen={actions.tag.chosen} onSelect={actions.tag.onSelect} />
            </div>
            <DetailButton row={actions.tag.more} onClose={onClose} />
            <DetailButton row={actions.remove} onClose={onClose} />
          </>
        )}
      </div>
    </Sheet>
  );
}

function DetailButton({ row, onClose }: { row: DetailRow; onClose(): void }) {
  return (
    <Button
      variant="quiet"
      icon={row.icon}
      className="phone-details-row"
      disabledReason={row.disabledReason}
      onClick={() => {
        onClose();
        row.run();
      }}
    >
      {row.label}
      {row.note && <small>{row.note}</small>}
    </Button>
  );
}
