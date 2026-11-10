import type { AgentRoleChoice } from "@localdot/protocol";
import { useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import type { ModelNames } from "../settings/model-names.ts";
import { Button } from "../ui/Button.tsx";
import { Group, GroupRow } from "../ui/Group.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu.tsx";
import { MiddleTruncate } from "../ui/MiddleTruncate.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import { Select } from "../ui/Select.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { showToast } from "../ui/Toast.tsx";
import type { Guest, GuestGrant } from "./guest.ts";

const same = (a: AgentRoleChoice, b: AgentRoleChoice) =>
  a.provider === b.provider && a.model === b.model;

// What a model reads as: the name the computer's catalog gives it, else its ID.
export function guestModelName(grant: GuestGrant, choice: AgentRoleChoice): string {
  return grant.names?.find((named) => same(named, choice))?.name ?? choice.model;
}

export function guestNames(grant: GuestGrant): ModelNames {
  return {
    provider: (route) => route,
    name: (_route, model) => grant.names?.find((named) => named.model === model)?.name ?? model,
  };
}

function useChooseModel(api: ApiClient, guest: Guest) {
  const [saving, setSaving] = useState(false);
  return {
    saving,
    choose(index: number) {
      const model = guest.grant.models[index];
      if (!model || saving) return;
      setSaving(true);
      void api
        .post("/api/remote-session/model", { index })
        .then(() => guest.refresh())
        .catch(() =>
          showToast({
            title: `Couldn't switch to ${guestModelName(guest.grant, model)}`,
            description: "Try again.",
            tone: "danger",
          }),
        )
        .finally(() => setSaving(false));
    },
  };
}

// The link's model in the composer's row: a pull-down where the link lets the guest choose.
export function GuestModelChip({ api, guest }: { api: ApiClient; guest: Guest }) {
  const { grant } = guest;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const model = useChooseModel(api, guest);
  const name = guestModelName(grant, grant.model);
  if (!grant.chooseModel || grant.models.length < 2)
    return <span className="composer-model guest-model">{name}</span>;
  return (
    <>
      <Button
        ref={button}
        variant="quiet"
        size="sm"
        className="composer-model"
        disabledReason={model.saving ? "Saving…" : undefined}
        aria-label={`Model: ${name}`}
        {...triggerProps("menu", open)}
        onClick={() => setOpen(true)}
      >
        <MiddleTruncate text={name} tail={Math.max(0, name.length - name.lastIndexOf(" "))} />
        <Icon name="chevron-down" size={12} className="composer-model-chevron" />
      </Button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        side="top"
        align="start"
        label="Model"
      >
        {grant.models.map((choice, index) => (
          <MenuItem
            key={`${choice.provider}/${choice.model}`}
            checked={same(choice, grant.model)}
            onSelect={() => model.choose(index)}
          >
            {guestModelName(grant, choice)}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

// A guest's ⋯ menu: only what the link lets them do.
export function GuestMenuItems({
  guest,
  newReason,
  onNew,
  onReplay,
  onSettings,
  onStop,
}: {
  guest: Guest;
  newReason?: string;
  onNew(): void;
  onReplay(): void;
  onSettings(): void;
  // The task at work is this link's own.
  onStop?(): void;
}) {
  return (
    <>
      <MenuItem icon="compose" disabledReason={newReason} onSelect={onNew}>
        New conversation
      </MenuItem>
      {guest.grant.replay && (
        <MenuItem icon="history" onSelect={onReplay}>
          Replay
        </MenuItem>
      )}
      {guest.grant.settings && (
        <MenuItem icon="settings" onSelect={onSettings}>
          Chat settings
        </MenuItem>
      )}
      {onStop && (
        <>
          <MenuSeparator />
          <MenuItem icon="stop" onSelect={onStop}>
            Stop
          </MenuItem>
        </>
      )}
    </>
  );
}

const money = (usd: number) => `$${usd.toFixed(2).replace(/\.00$/, "")}`;

// What the link allows, and the model where the guest may choose it. The computer's own settings
// are the owner's.
export function GuestSettingsSheet({
  api,
  guest,
  open,
  onClose,
}: {
  api: ApiClient;
  guest: Guest;
  open: boolean;
  onClose(): void;
}) {
  const { grant } = guest;
  const model = useChooseModel(api, guest);
  const current = grant.models.findIndex((choice) => same(choice, grant.model));
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Chat settings"
      description={`Shared with you as ${grant.label}. The owner manages this computer and its saved keys.`}
      detents={["fit"]}
      className="guest-settings-sheet"
    >
      <Group className="guest-settings">
        <GroupRow
          label="Model"
          trailing={
            grant.chooseModel && grant.models.length > 1 ? (
              <Select
                aria-label="Model"
                appearance="inline"
                value={String(current)}
                items={grant.models.map((choice, index) => ({
                  value: String(index),
                  label: guestModelName(grant, choice),
                }))}
                onValueChange={(value) => model.choose(Number(value))}
              />
            ) : (
              guestModelName(grant, grant.model)
            )
          }
        />
        <GroupRow
          label="Tasks"
          trailing={
            grant.maxTasks === null
              ? `${grant.tasks} used`
              : `${grant.tasks} of ${grant.maxTasks} used`
          }
        />
        <GroupRow
          label="Budget for each task"
          detail="Tasks on a subscription plan follow the plan's allowance."
          trailing={money(grant.taskBudgetUSD)}
        />
        <GroupRow
          label="Access ends"
          trailing={
            grant.expiresAt
              ? new Date(grant.expiresAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : "When the owner ends it"
          }
        />
      </Group>
    </Sheet>
  );
}
