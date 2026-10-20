import type { AgentRoleChoice } from "@localdot/protocol";
import { sameModelOptions } from "@localdot/providers";
import { type RefObject, useRef, useState } from "react";
import { ModelOptionsFields, optionsLabel } from "../settings/ModelOptionsFields.tsx";
import type { ModelGroup, ModelOption } from "../settings/model-options.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { MiddleTruncate } from "../ui/MiddleTruncate.tsx";
import { mergeHandlers } from "../ui/merge.ts";
import { Popover, triggerProps } from "../ui/Popover.tsx";
import type { Align, Side } from "../ui/position.ts";
import { Select } from "../ui/Select.tsx";
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
  choice?: AgentRoleChoice;
  outputLimit?(choice: AgentRoleChoice): number;
  // A task is at work: it keeps its model, and a choice starts with the next task.
  working?: boolean;
  onChoose(option: ModelOption): void;
  // Given what the menu opened from, which takes the focus back when Settings closes.
  onManage(trigger: HTMLElement): void;
}

// Model and thinking settings share one panel. Edits are local until Apply; Escape discards
// them. Catalog/account refreshes never remount the slider or steal the user's focus.
export function ModelMenu(props: ModelMenuProps) {
  return (
    <Popover
      open={props.open}
      onClose={props.onClose}
      anchor={props.anchor}
      side={props.side}
      align={props.align}
      label="Model and thinking"
      className="model-config-panel"
    >
      <ModelMenuBody key={props.open ? "open" : "closed"} {...props} />
    </Popover>
  );
}
function ModelMenuBody({
  groups,
  current,
  choice,
  working,
  onChoose,
  onManage,
  outputLimit,
  ...props
}: ModelMenuProps) {
  const choices = groups.flatMap((group) => group.options);
  const selected = choices.find((option) => option.id === current);
  const [draft, setDraft] = useState<ModelOption | undefined>(() =>
    selected ? { ...selected, choice: choice ?? selected.choice } : undefined,
  );
  const dirty =
    draft &&
    (draft.id !== current ||
      !sameModelOptions(draft.choice.options, choice?.options ?? selected?.choice.options));
  return (
    <div className="model-config-content">
      <div className="model-config-heading">
        <span>Model & thinking</span>
        <IconButton
          icon="undo-2"
          size={24}
          label="Reset to provider defaults"
          disabledReason={draft?.choice.options ? undefined : "Using provider defaults"}
          onClick={() => {
            if (draft) setDraft({ ...draft, choice: { ...draft.choice, options: undefined } });
          }}
        />
      </div>
      {working && (
        <p className="model-options-note">
          Applies from the next task. This one keeps its settings.
        </p>
      )}
      <Select
        aria-label="Model"
        value={draft?.id ?? ""}
        groups={groups.map((group) => ({
          label: group.label,
          items: group.options.map((option) => ({ value: option.id, label: option.name })),
        }))}
        onValueChange={(id) => setDraft(choices.find((option) => option.id === id))}
      />
      {draft && (
        <ModelOptionsFields
          compact
          choice={draft.choice}
          accountModel={choices.find((option) => option.id === draft.id)?.accountModel}
          discovered={choices.find((option) => option.id === draft.id)?.controls}
          outputLimit={outputLimit?.(draft.choice)}
          onChange={(choice) => setDraft({ ...draft, choice })}
        />
      )}
      <div className="model-config-actions">
        <Button
          variant="quiet"
          size="sm"
          className="model-config-manage"
          onClick={() => {
            props.onClose();
            if (props.anchor.current) onManage(props.anchor.current);
          }}
        >
          Manage models…
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabledReason={dirty ? undefined : "Settings are already selected"}
          onClick={() => {
            if (draft && dirty) {
              onChoose(draft);
              props.onClose();
            }
          }}
        >
          Apply
        </Button>
      </div>
    </div>
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
        {...triggerProps("dialog", open)}
        onClick={() => {
          onPeek?.();
          setOpen(true);
        }}
      >
        <MiddleTruncate text={label} tail={Math.max(0, label.length - label.lastIndexOf(" "))} />
        {menu.choice?.options && (
          <span className="composer-effort">{optionsLabel(menu.choice.options)}</span>
        )}
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
