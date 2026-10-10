import { type RefObject, useRef, useState } from "react";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";

export function PanelMenu({
  buttonRef,
  chat,
  activity,
  onChat,
  onActivity,
}: {
  buttonRef?: RefObject<HTMLButtonElement | null>;
  chat: boolean;
  activity: boolean;
  onChat(): void;
  onActivity(): void;
}) {
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
        <MenuItem icon={activity ? "eye-off" : "eye"} onSelect={onActivity}>
          {activity ? "Hide activity" : "Show activity"}
        </MenuItem>
      </Menu>
    </>
  );
}
