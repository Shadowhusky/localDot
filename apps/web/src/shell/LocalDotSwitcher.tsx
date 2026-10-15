import type { LocalDotLink } from "@localdot/protocol";
import { useRef, useState } from "react";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Menu, MenuGroup, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import { localDotHost } from "./local-dots.ts";

// The wordmark as a menu of the user's localDots: this one, named when it has a name, and the
// others, each opened at its own address in this tab.
export function LocalDotSwitcher({
  name,
  others,
  onManage,
}: {
  name?: string;
  others: readonly LocalDotLink[];
  onManage(trigger: HTMLElement): void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={anchor}
        variant="quiet"
        size="sm"
        className="bar-brand"
        aria-label={name ? `localDot: ${name}. Switch localDot` : "Switch localDot"}
        {...triggerProps("menu", open)}
        onClick={() => setOpen(!open)}
      >
        <span className="bar-wordmark">localDot</span>
        {name && <span className="bar-brand-name">{name}</span>}
        <Icon name="chevron-down" size={14} className="bar-brand-chevron" />
      </Button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label="localDots">
        <MenuGroup label="localDots">
          <MenuItem textValue={name ?? "This localDot"} checked onSelect={() => setOpen(false)}>
            {name ?? "This localDot"}
          </MenuItem>
          {others.map((link) => (
            <MenuItem
              key={link.url}
              textValue={link.name}
              onSelect={() => window.location.assign(link.url)}
            >
              <span className="bar-brand-item">
                <span>{link.name}</span>
                <span className="bar-brand-host">{localDotHost(link.url)}</span>
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuItem
          icon="settings"
          onSelect={() => {
            setOpen(false);
            if (anchor.current) onManage(anchor.current);
          }}
        >
          {others.length ? "Add or manage localDots…" : "Add another localDot…"}
        </MenuItem>
      </Menu>
    </>
  );
}
