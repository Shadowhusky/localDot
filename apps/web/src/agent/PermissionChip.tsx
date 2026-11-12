import { useRef, useState } from "react";
import { t, tr } from "../i18n/index.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";

const modes = {
  custom: {
    name: tr("Custom"),
    icon: "sliders-horizontal",
    detail: tr("Follow your permissions in Settings."),
  },
  auto: {
    name: tr("Auto"),
    icon: "shield",
    detail: tr(
      "Jev approves routine actions, including cleanup inside the computer. You decide when it’s unsure.",
    ),
  },
  full: {
    name: tr("Full access"),
    icon: "bolt",
    detail: tr(
      "Local work and downloads run without asking. Purchases and online deletes still ask. Purpose check is bypassed.",
    ),
  },
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
        icon={modes[value].icon}
        size={28}
        className="composer-permissions"
        data-mode={value}
        label={t`Permission mode: ${modes[value].name}`}
        disabledReason={busy ? t`Saving permissions…` : undefined}
        {...triggerProps("menu", open)}
        onClick={() => setOpen(true)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        side="top"
        label={t`Permission mode`}
        className="permission-menu"
      >
        <p className="permission-menu-heading" role="none">
          {t`Permissions`}
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
            <span className="permission-menu-name">
              <Icon name={modes[mode].icon} />
              {modes[mode].name}
            </span>
            <span className="permission-menu-detail">{modes[mode].detail}</span>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
