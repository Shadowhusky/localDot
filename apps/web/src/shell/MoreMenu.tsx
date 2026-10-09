import { useRef, useState } from "react";
import { IconButton } from "../ui/IconButton.tsx";
import type { IconName } from "../ui/icons.ts";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";

export interface MoreItem {
  label: string;
  icon: IconName;
  // Given the More button, which takes the focus back when what it opens closes.
  run(trigger: HTMLButtonElement): void;
  disabledReason?: string;
}

// Where a phone keeps what a wider screen shows in its top bar.
export function MoreMenu({ items }: { items: readonly MoreItem[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={button}
        size={32}
        icon="more-horizontal"
        label="More"
        {...triggerProps("menu", open)}
        onClick={() => setOpen(true)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        side="bottom"
        align="end"
        label="More"
      >
        {items.map((item) => (
          <MenuItem
            key={item.label}
            icon={item.icon}
            disabledReason={item.disabledReason}
            onSelect={() => {
              if (button.current) item.run(button.current);
            }}
          >
            {item.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
