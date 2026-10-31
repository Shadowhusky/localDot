import { Fragment, useRef, useState } from "react";
import { IconButton } from "../ui/IconButton.tsx";
import type { IconName } from "../ui/icons.ts";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";

export interface MoreItem {
  label: string;
  icon: IconName;
  // Given the More button, which takes the focus back when what it opens closes.
  run(trigger: HTMLButtonElement): void;
  disabledReason?: string;
  // A line above it, where a new group of items starts.
  startsGroup?: boolean;
}

// Where a phone keeps what a wider screen shows in its top bar: at the toolbar's trailing end, its
// menu rising from the button.
export function MoreMenu({
  items,
  onOpen,
}: {
  items: readonly MoreItem[];
  // Asked as it opens, so what it lists is fresh.
  onOpen?(): void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={button}
        size={36}
        round
        className="toolbar-button"
        icon="more-horizontal"
        label="More"
        {...triggerProps("menu", open)}
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        side="top"
        align="end"
        label="More"
        dim
      >
        {items.map((item, index) => (
          <Fragment key={item.label}>
            {item.startsGroup && index > 0 && <MenuSeparator />}
            <MenuItem
              icon={item.icon}
              disabledReason={item.disabledReason}
              onSelect={() => {
                if (button.current) item.run(button.current);
              }}
            >
              {item.label}
            </MenuItem>
          </Fragment>
        ))}
      </Menu>
    </>
  );
}
