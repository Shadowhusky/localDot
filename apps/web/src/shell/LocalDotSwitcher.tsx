import type { DotSummary, LocalDotLink } from "@localdot/protocol";
import { useRef, useState } from "react";
import { DOT_STATE_WORD } from "../settings/dot-copy.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Menu, MenuGroup, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import { showToast } from "../ui/Toast.tsx";
import { localDotHost } from "./local-dots.ts";
import { StopDotDialog } from "./StopDotDialog.tsx";
import { type LocalDots, switchToDot } from "./useLocalDots.ts";

// The wordmark as a menu of the user's localDots: the dots on this computer, each with its state,
// then the others the user listed, each opened at its own address in this tab.
export function LocalDotSwitcher({
  name,
  others,
  here,
  onManage,
  onAddHere,
}: {
  name?: string;
  others: readonly LocalDotLink[];
  here?: LocalDots;
  onManage(trigger: HTMLElement): void;
  // Settings' place for adding a dot on this computer, offered when this installation can.
  onAddHere?(trigger: HTMLElement): void;
}) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<DotSummary | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const dots = here?.dots && here.dots.length > 1 ? here.dots : null;
  const running = dots?.filter((dot) => !dot.self && dot.state === "running") ?? [];
  return (
    <>
      <span className="bar-brand-slot">
        <Button
          ref={anchor}
          variant="quiet"
          size="sm"
          className="bar-brand"
          aria-label={name ? `localDot: ${name}. Switch localDot` : "Switch localDot"}
          {...triggerProps("menu", open)}
          onClick={() => {
            if (!open) here?.refresh();
            setOpen(!open);
          }}
        >
          <span className="bar-wordmark">localDot</span>
          {name && (
            <span className="bar-brand-name" title={name}>
              {name}
            </span>
          )}
          <Icon name="chevron-down" size={14} className="bar-brand-chevron" />
        </Button>
      </span>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} label="localDots">
        {dots && here && (
          <MenuGroup label="On this computer">
            {dots.map((dot) => (
              <MenuItem
                key={dot.id}
                textValue={dot.name}
                checked={dot.self ? true : undefined}
                onSelect={() => switchToDot(here, dot)}
              >
                <span className="bar-brand-item">
                  <span>{dot.name}</span>
                  {!dot.self && <span className="bar-brand-host">{DOT_STATE_WORD[dot.state]}</span>}
                </span>
              </MenuItem>
            ))}
            {here.manage &&
              running.map((dot) => (
                <MenuItem
                  key={`stop-${dot.id}`}
                  icon="stop"
                  textValue={`Stop ${dot.name}`}
                  onSelect={() => setStopping(dot)}
                >
                  {`Stop ${dot.name}…`}
                </MenuItem>
              ))}
          </MenuGroup>
        )}
        {(!dots || others.length > 0) && (
          <MenuGroup label={dots ? "Your other localDots" : "localDots"}>
            {!dots && (
              <MenuItem textValue={name ?? "This localDot"} checked onSelect={() => setOpen(false)}>
                {name ?? "This localDot"}
              </MenuItem>
            )}
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
        )}
        {here?.manage && onAddHere && (
          <MenuItem
            icon="plus"
            onSelect={() => {
              if (anchor.current) onAddHere(anchor.current);
            }}
          >
            Add a dot on this computer…
          </MenuItem>
        )}
        <MenuItem
          icon="settings"
          onSelect={() => {
            setOpen(false);
            if (anchor.current) onManage(anchor.current);
          }}
        >
          {others.length || dots ? "Add or manage localDots…" : "Add another localDot…"}
        </MenuItem>
      </Menu>
      {here && (
        <StopDotDialog
          dot={stopping}
          anchor={anchor}
          onClose={() => setStopping(null)}
          onStop={(dot) => {
            setStopping(null);
            void here.stop(dot).then((problem) => {
              if (problem)
                showToast({
                  title: `Couldn't stop ${dot.name}`,
                  description: problem,
                  tone: "danger",
                });
            });
          }}
        />
      )}
    </>
  );
}
