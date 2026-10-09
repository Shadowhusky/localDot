import { Fragment, type RefObject, useRef, useState } from "react";
import type { ModelGroup, ModelOption } from "../settings/model-options.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Menu, MenuGroup, MenuItem, MenuSeparator } from "../ui/Menu.tsx";
import { MiddleTruncate } from "../ui/MiddleTruncate.tsx";
import { mergeHandlers } from "../ui/merge.ts";
import { triggerProps } from "../ui/Popover.tsx";
import type { Align, Side } from "../ui/position.ts";
import { useTooltip } from "../ui/Tooltip.tsx";

export interface ModelMenuProps {
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null>;
  side?: Side;
  align?: Align;
  dim?: boolean;
  groups: readonly ModelGroup[];
  current?: string;
  // A task is at work: it keeps its model, and a choice starts with the next task.
  working?: boolean;
  onChoose(option: ModelOption): void;
  // Given what the menu opened from, which takes the focus back when Settings closes.
  onManage(trigger: HTMLElement): void;
}

// The models the user can switch to, by provider, the current one checked; then Settings for the
// rest.
export function ModelMenu({
  groups,
  current,
  working,
  onChoose,
  onManage,
  ...props
}: ModelMenuProps) {
  return (
    <Menu {...props} label="Model" className="model-menu">
      {working && (
        <p role="none" className="model-menu-note">
          Applies from the next task. This one keeps its model.
        </p>
      )}
      {groups.map((group) => (
        <Fragment key={group.label}>
          <MenuGroup label={group.label}>
            {group.options.map((option) => (
              <MenuItem
                key={option.id}
                checked={option.id === current}
                onSelect={() => {
                  if (option.id !== current) onChoose(option);
                }}
              >
                {option.name}
              </MenuItem>
            ))}
          </MenuGroup>
          <MenuSeparator />
        </Fragment>
      ))}
      <MenuItem
        onSelect={() => {
          if (props.anchor.current) onManage(props.anchor.current);
        }}
      >
        Manage models…
      </MenuItem>
    </Menu>
  );
}

export interface ModelChipProps extends Omit<ModelMenuProps, "open" | "onClose" | "anchor"> {
  // The main model, or the one being saved.
  name: string;
  // The task at work keeps its own model: the chosen one starts with the next task.
  next?: boolean;
  disabledReason?: string;
  // The pointer is on its way, or focus arrived: the plans in the menu can be read in time.
  onPeek?(): void;
}

// The main model, in the composer's row: a quiet pull-down that opens the menu above it.
export function ModelChip({ name, next, disabledReason, onPeek, ...menu }: ModelChipProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { triggerProps: tip, tooltip } = useTooltip({
    content: !disabledReason && next ? "Starts with the next task" : undefined,
  });
  // The menu and the label give the full name; the chip leaves out a family name the rest says.
  const label = name.replace(/^Claude (?=[A-Za-z])/, "");
  return (
    <>
      <Button
        {...mergeHandlers({ onPointerEnter: onPeek, onFocus: onPeek }, tip.handlers)}
        ref={button}
        variant="quiet"
        size="sm"
        className="composer-model"
        disabledReason={disabledReason}
        aria-label={next ? `Model for the next task: ${name}` : `Model: ${name}`}
        aria-describedby={tip["aria-describedby"]}
        {...triggerProps("menu", open)}
        onClick={() => {
          onPeek?.();
          setOpen(true);
        }}
      >
        <MiddleTruncate text={label} tail={Math.max(0, label.length - label.lastIndexOf(" "))} />
        <Icon name="chevron-down" size={12} className="composer-model-chevron" />
      </Button>
      {tooltip}
      <ModelMenu
        {...menu}
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        side="top"
        align="start"
      />
    </>
  );
}
