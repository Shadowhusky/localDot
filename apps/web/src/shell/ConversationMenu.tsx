import type { ConversationEntry, LookWearables } from "@localdot/protocol";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { type Organize, tagIds, toggledTag } from "../agent/conversation-list.ts";
import { t } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { TagSwatches } from "../ui/ConversationTag.tsx";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu.tsx";
import { type Align, levelWith, type Side } from "../ui/position.ts";
import { LookChooser } from "./LookChooser.tsx";
import { TagChooser } from "./TagChooser.tsx";

export interface ConversationMenuProps {
  api: ApiClient;
  // The conversation acted on; the menu is open while there is one.
  entry: ConversationEntry | null;
  anchor: RefObject<HTMLElement | null>;
  // The row acted on and the list it sits in: the menu stands against the list's edge, level with
  // the row, however it was opened. Without them it hangs from the anchor.
  row?: RefObject<HTMLElement | null>;
  list?: RefObject<HTMLElement | null>;
  onClose(): void;
  side?: Side;
  align?: Align;
  // Its task is under way, so it can't be archived or deleted yet.
  running: boolean;
  renameKeys?: readonly string[];
  onRename(): void;
  onOrganize(change: Organize): void;
  // Its dot's look, which outlives the menu: the chooser stays open once the menu has gone.
  onLook(entry: ConversationEntry, look: LookWearables | null): void;
  onDelete(): void;
  // Starts selecting with this one, to act on several together.
  onStartSelecting?(): void;
  // Items of the list's own, above the rest.
  children?: ReactNode;
}

// What can be done to one conversation from its row: choose it among others, name it, dress its dot,
// keep it on top, put it away, tag it, or delete it.
export function ConversationMenu({
  api,
  entry,
  anchor,
  row,
  list,
  onClose,
  side,
  align = "start",
  running,
  renameKeys,
  onRename,
  onOrganize,
  onLook,
  onDelete,
  onStartSelecting,
  children,
}: ConversationMenuProps) {
  const [dressing, setDressing] = useState<ConversationEntry | null>(null);
  const [tagging, setTagging] = useState<ConversationEntry | null>(null);
  // While it closes it still says what it said, rather than what the choice just changed.
  const last = useRef(entry);
  if (entry) last.current = entry;
  const shown = entry ?? last.current;
  const archived = !!shown?.archived;
  return (
    <>
      <Menu
        open={entry !== null}
        onClose={onClose}
        anchor={anchor}
        against={() =>
          row?.current && list?.current ? levelWith(row.current, list.current) : undefined
        }
        label={t`Conversation actions`}
        side={side}
        align={align}
      >
        {children}
        {onStartSelecting && (
          <MenuItem icon="check-circle" onSelect={onStartSelecting}>
            {t`Select`}
          </MenuItem>
        )}
        <MenuItem icon="type" kbd={renameKeys} onSelect={onRename}>
          {t`Rename`}
        </MenuItem>
        <MenuItem icon="smile" onSelect={() => setDressing(shown)}>
          {t`Change look`}
        </MenuItem>
        <MenuItem
          icon={shown?.pinned ? "pin-off" : "pin"}
          onSelect={() => onOrganize({ pinned: !shown?.pinned })}
        >
          {shown?.pinned ? t`Unpin` : t`Pin to top`}
        </MenuItem>
        <MenuItem
          icon={archived ? "archive-restore" : "archive"}
          disabledReason={
            running && !archived ? t`Stop this task before archiving its conversation.` : undefined
          }
          onSelect={() => onOrganize({ archived: !archived })}
        >
          {archived ? t`Unarchive` : t`Archive`}
        </MenuItem>
        <MenuSeparator />
        <TagSwatches
          chosen={tagIds(shown)}
          onSelect={(tag) => onOrganize({ tags: toggledTag(tagIds(shown), tag) })}
        />
        <MenuItem icon="tag" onSelect={() => setTagging(shown)}>
          {t`Tags…`}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon="trash"
          disabledReason={running ? t`Stop this task before deleting its conversation.` : undefined}
          onSelect={onDelete}
        >
          {t`Delete conversation`}
        </MenuItem>
      </Menu>
      <LookChooser
        entry={dressing}
        anchor={anchor}
        onChange={onLook}
        onClose={() => setDressing(null)}
      />
      <TagChooser api={api} entry={tagging} anchor={anchor} onClose={() => setTagging(null)} />
    </>
  );
}
