import type { ConversationEntry } from "@localdot/protocol";
import { type ReactNode, type RefObject, useRef } from "react";
import type { Organize } from "../agent/conversation-list.ts";
import { TagSwatches } from "../ui/ConversationTag.tsx";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu.tsx";
import type { Align, Side } from "../ui/position.ts";

export interface ConversationMenuProps {
  // The conversation acted on; the menu is open while there is one.
  entry: ConversationEntry | null;
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  side?: Side;
  align?: Align;
  // Its task is under way, so it can't be archived or deleted yet.
  running: boolean;
  renameKeys?: readonly string[];
  onRename(): void;
  onOrganize(change: Organize): void;
  onDelete(): void;
  // Items of the list's own, above the rest.
  children?: ReactNode;
}

// What can be done to one conversation from its row: name it, keep it on top, put it away, tell it
// apart by colour, or delete it.
export function ConversationMenu({
  entry,
  anchor,
  onClose,
  side,
  align = "start",
  running,
  renameKeys,
  onRename,
  onOrganize,
  onDelete,
  children,
}: ConversationMenuProps) {
  // While it closes it still says what it said, rather than what the choice just changed.
  const last = useRef(entry);
  if (entry) last.current = entry;
  const shown = entry ?? last.current;
  const archived = !!shown?.archived;
  return (
    <Menu
      open={entry !== null}
      onClose={onClose}
      anchor={anchor}
      label="Conversation actions"
      side={side}
      align={align}
    >
      {children}
      <MenuItem icon="type" kbd={renameKeys} onSelect={onRename}>
        Rename
      </MenuItem>
      <MenuItem
        icon={shown?.pinned ? "pin-off" : "pin"}
        onSelect={() => onOrganize({ pinned: !shown?.pinned })}
      >
        {shown?.pinned ? "Unpin" : "Pin to top"}
      </MenuItem>
      <MenuItem
        icon={archived ? "archive-restore" : "archive"}
        disabledReason={
          running && !archived ? "Stop this task before archiving its conversation." : undefined
        }
        onSelect={() => onOrganize({ archived: !archived })}
      >
        {archived ? "Unarchive" : "Archive"}
      </MenuItem>
      <MenuSeparator />
      <TagSwatches value={shown?.tag ?? null} onSelect={(tag) => onOrganize({ tag })} />
      <MenuSeparator />
      <MenuItem
        icon="trash"
        disabledReason={running ? "Stop this task before deleting its conversation." : undefined}
        onSelect={onDelete}
      >
        Delete conversation
      </MenuItem>
    </Menu>
  );
}
