import { type RefObject, useRef, useState, useSyncExternalStore } from "react";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";

import {
  commandsHidden,
  onCommandsVisibility,
  requestHideCommands,
  requestShowCommands,
} from "./work-overlay.ts";

export function PanelMenu({
  buttonRef,
  chat,
  onChat,
  commandsUnavailable,
}: {
  buttonRef?: RefObject<HTMLButtonElement | null>;
  commandsUnavailable?: string;
  chat: boolean;
  onChat(): void;
}) {
  const hidden = useSyncExternalStore(onCommandsVisibility, commandsHidden);
  const [open, setOpen] = useState(false);
  const ownAnchor = useRef<HTMLButtonElement>(null);
  const anchor = buttonRef ?? ownAnchor;
  return (
    <>
      <IconButton
        ref={anchor}
        icon="layout-grid"
        label="Panels"
        size={32}
        {...triggerProps("menu", open)}
        onClick={() => setOpen(true)}
      />
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label="Panels" align="end">
        <MenuItem icon={chat ? "eye-off" : "eye"} onSelect={onChat}>
          {chat ? "Hide chat" : "Show chat"}
        </MenuItem>
        <MenuItem
          icon="terminal"
          disabledReason={commandsUnavailable}
          onSelect={hidden ? requestShowCommands : requestHideCommands}
        >
          {hidden ? "Show commands" : "Hide commands"}
        </MenuItem>
      </Menu>
    </>
  );
}

// Fullscreen keeps the command-window toggle beside the other screen controls.
export function CommandsButton({ unavailable }: { unavailable?: string }) {
  const hidden = useSyncExternalStore(onCommandsVisibility, commandsHidden);
  return (
    <IconButton
      icon="terminal"
      label={hidden ? "Show commands" : "Hide commands"}
      size={44}
      round
      variant="filled"
      disabledReason={unavailable}
      aria-pressed={!hidden}
      onClick={hidden ? requestShowCommands : requestHideCommands}
    />
  );
}

export function CommandsMenuItem() {
  const hidden = useSyncExternalStore(onCommandsVisibility, commandsHidden);
  return (
    <MenuItem icon="terminal" onSelect={hidden ? requestShowCommands : requestHideCommands}>
      {hidden ? "Show commands" : "Hide commands"}
    </MenuItem>
  );
}
