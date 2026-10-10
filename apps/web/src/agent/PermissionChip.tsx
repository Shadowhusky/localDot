import { useRef, useState } from "react";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";

const modes = {
  custom: { name: "Custom", detail: "Follow your permissions in Settings." },
  auto: { name: "Auto", detail: "Jev approves routine actions. You decide when it’s unsure." },
  full: { name: "Full access", detail: "Act without asking, except for destructive actions." },
} as const;

export function PermissionChip({
  value,
  busy,
  onChoose,
}: {
  value: keyof typeof modes;
  busy: boolean;
  onChoose(value: keyof typeof modes): void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={anchor}
        icon="shield"
        size={28}
        className="composer-permissions"
        data-mode={value}
        label={`Permission mode: ${modes[value].name}`}
        disabledReason={busy ? "Saving permissions…" : undefined}
        {...triggerProps("menu", open)}
        onClick={() => setOpen(true)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        side="top"
        label="Permission mode"
        className="permission-menu"
      >
        <p className="permission-menu-heading" role="none">
          Permissions
        </p>
        {(Object.keys(modes) as (keyof typeof modes)[]).map((mode) => (
          <MenuItem
            key={mode}
            textValue={modes[mode].name}
            checked={value === mode}
            onSelect={() => {
              if (mode !== value) onChoose(mode);
            }}
          >
            <span className="permission-menu-name">{modes[mode].name}</span>
            <span className="permission-menu-detail">{modes[mode].detail}</span>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
