import { t } from "../i18n/index.ts";
import { Group, GroupRow } from "../ui/Group.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { type Guest, guestModelName } from "./guest.ts";

const money = (usd: number) => `$${usd.toFixed(2).replace(/\.00$/, "")}`;

// What the link allows. The model is chosen in the composer, as the owner chooses it; the
// computer's own settings are the owner's, so a guest has this in Settings' place.
export function GuestSettingsSheet({
  guest,
  open,
  onClose,
}: {
  guest: Guest;
  open: boolean;
  onClose(): void;
}) {
  const { grant } = guest;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t`Chat settings`}
      description={t`Shared with you as ${grant.label}. The owner manages this computer and its saved keys.`}
      detents={["fit"]}
      className="guest-settings-sheet"
    >
      <Group className="guest-settings">
        <GroupRow
          label={t`Model`}
          detail={grant.chooseModel ? t`Change it from the message box.` : undefined}
          trailing={guestModelName(grant, grant.model)}
        />
        <GroupRow
          label={t`Tasks`}
          trailing={
            grant.maxTasks === null
              ? t`${grant.tasks} used`
              : t`${grant.tasks} of ${grant.maxTasks} used`
          }
        />
        <GroupRow
          label={t`Budget for each task`}
          detail={t`Tasks on a subscription plan follow the plan's allowance.`}
          trailing={money(grant.taskBudgetUSD)}
        />
        <GroupRow
          label={t`Access ends`}
          trailing={
            grant.expiresAt
              ? new Date(grant.expiresAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : t`When the owner ends it`
          }
        />
      </Group>
    </Sheet>
  );
}
