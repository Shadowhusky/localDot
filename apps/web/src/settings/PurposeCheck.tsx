import { Collapse } from "../ui/Disclosure.tsx";
import { Group, GroupRow } from "../ui/Group.tsx";
import { Switch } from "../ui/Switch.tsx";

// What Auto checks with: a saved Jev key, else the fast model, else nothing yet.
export type PurposeJudge = "jev" | "fast" | "none";

export interface PurposeCheckControl {
  on: boolean;
  change(on: boolean): void;
  judge: PurposeJudge;
  // Opens Keys with a Jev key's form filled in.
  addJevKey?(trigger: HTMLButtonElement): void;
}

const CHECKED_BY: Readonly<Record<PurposeJudge, string>> = {
  jev: "Jev",
  fast: "Your fast model",
  none: "Nothing yet",
};

export function PurposeCheck({ control }: { control: PurposeCheckControl }) {
  const { on, judge, addJevKey } = control;
  return (
    <Group>
      <Switch
        className="ui-group-row"
        label="Purpose check"
        description="Stops dot sending what it read somewhere unrelated to your request"
        checked={on}
        onCheckedChange={control.change}
      />
      <Collapse open={on}>
        <GroupRow label="Checked by" trailing={CHECKED_BY[judge]} />
        {addJevKey && judge !== "jev" && (
          <GroupRow
            label="Add a Jev key"
            detail={
              judge === "none"
                ? "Needed unless you choose a fast model. It goes in Keys."
                : "For quicker checks. It goes in Keys."
            }
            onSelect={addJevKey}
          />
        )}
      </Collapse>
    </Group>
  );
}
