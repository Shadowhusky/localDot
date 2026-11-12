import { useRef, useState } from "react";
import { t, tr } from "../i18n/index.ts";
import type { StreamPreferenceControl } from "../stage/stream-preference.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuGroup, MenuItem, MenuSeparator } from "../ui/Menu.tsx";
import { useMediaQuery } from "../ui/media.ts";
import { triggerProps } from "../ui/Popover.tsx";
import { LANDSCAPE_PHONE } from "./layout.ts";

export interface DisplayControl {
  value: string;
  change(value: string): void;
}

const choices = [
  { value: "auto", label: tr("Auto"), detail: tr("Adapt to your connection") },
  { value: "sharp", label: tr("Sharp"), detail: tr("Keep text crisp") },
  { value: "smooth", label: tr("Smooth"), detail: tr("Keep motion fluid") },
] as const;

export function StreamMenu({
  stream,
  display,
}: {
  stream: StreamPreferenceControl;
  display?: DisplayControl;
}) {
  const [open, setOpen] = useState(false);
  const landscape = useMediaQuery(LANDSCAPE_PHONE);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={anchor}
        icon="settings"
        label={t`Stream settings`}
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
        side={landscape ? "left" : "top"}
        label={t`Stream settings`}
        className="stream-menu"
      >
        {display && (
          <MenuGroup label={t`Display view`}>
            {[
              { value: "auto", label: t`Auto`, detail: t`Follow the agent’s work` },
              { value: "work", label: t`Work`, detail: t`Keep the current output` },
              { value: "screen", label: t`Screen`, detail: t`Watch the computer` },
            ].map((choice) => (
              <MenuItem
                key={choice.value}
                textValue={choice.label}
                checked={display.value === choice.value}
                onSelect={() => display.change(choice.value)}
              >
                <span className="stream-menu-name">{choice.label}</span>
                <span className="stream-menu-detail">{choice.detail}</span>
              </MenuItem>
            ))}
          </MenuGroup>
        )}
        {display && <MenuSeparator />}
        <MenuGroup label={t`Stream quality`}>
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
        <p className="stream-menu-note" role="note">
          {t`Full quality when your connection allows.`}
        </p>
        {!stream.saved && (
          <p className="stream-menu-note" role="status">
            {t`Applied for this visit. This browser couldn’t save it.`}
          </p>
        )}
      </Menu>
    </>
  );
}
