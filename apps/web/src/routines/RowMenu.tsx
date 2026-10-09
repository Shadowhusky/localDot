import { type ReactNode, type RefObject, useRef, useState } from "react";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";

// A row's quiet ⋯ button and the menu that grows from it.
export function RowMenu({
  label,
  size = 28,
  ref,
  children,
}: {
  label: string;
  size?: 28 | 32 | 44;
  // The button, for a dialog one of the items opens beside it.
  ref?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const own = useRef<HTMLButtonElement>(null);
  const button = ref ?? own;
  return (
    <>
      <IconButton
        ref={button}
        size={size}
        icon="more-horizontal"
        label={label}
        {...triggerProps("menu", open)}
        onClick={() => setOpen(true)}
      />
      <Menu open={open} onClose={() => setOpen(false)} anchor={button} align="end" label={label}>
        {children}
      </Menu>
    </>
  );
}
