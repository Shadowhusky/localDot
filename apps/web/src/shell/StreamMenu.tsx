import { useRef, useState } from "react";
import type { StreamPreferenceControl } from "../stage/stream-preference.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuGroup, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";

const choices = [
  { value: "auto", label: "Auto", detail: "Adapt to your connection" },
  { value: "sharp", label: "Sharp", detail: "Keep text crisp" },
  { value: "smooth", label: "Smooth", detail: "Keep motion fluid" },
] as const;

export function StreamMenu({ stream }: { stream: StreamPreferenceControl }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={anchor}
        icon="settings"
        label="Stream settings"
        variant="filled"
        round
        size={44}
        {...triggerProps("menu", open)}
        onClick={() => setOpen(!open)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        side="top"
        label="Stream settings"
        className="stream-menu"
      >
        <MenuGroup label="Stream quality">
          {choices.map((choice) => (
            <MenuItem
              key={choice.value}
              textValue={choice.label}
              checked={stream.value === choice.value}
              onSelect={() => stream.change(choice.value)}
            >
              <span className="stream-menu-name">{choice.label}</span>
              <span className="stream-menu-detail">{choice.detail}</span>
            </MenuItem>
          ))}
        </MenuGroup>
        {!stream.saved && (
          <p className="stream-menu-note" role="status">
            Applied for this visit. This browser couldn’t save it.
          </p>
        )}
      </Menu>
    </>
  );
}
