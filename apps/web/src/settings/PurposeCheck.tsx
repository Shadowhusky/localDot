import { Collapse } from "../ui/Disclosure.tsx";
import { Group, GroupRow } from "../ui/Group.tsx";
import { Switch } from "../ui/Switch.tsx";
import { CLAUDE_CODE, subscription } from "./chooser.ts";
import type { SettingsDraft } from "./settings-form.ts";

// What Auto checks with: a saved Jev key, else the fast model, else nothing yet.
export type PurposeJudge = "jev" | "fast" | "none";

export interface PurposeCheckControl {
  on: boolean;
  change(on: boolean): void;
  judge: PurposeJudge;
  // The plan the main model runs on, if any. A plan runs no fast model of its own, so only a Jev
  // key can check.
  plan?: string;
  // Opens Keys with a Jev key's form filled in.
  addJevKey?(trigger: HTMLButtonElement): void;
}

export function purposeJudge(jevKey: boolean, choices: SettingsDraft["choices"]): PurposeJudge {
  if (jevKey) return "jev";
  return choices.fast && !subscription(choices.main?.provider) ? "fast" : "none";
}

const WHY = "Stops dot sending what it read somewhere unrelated to your request.";

export function purposeDescription({
  on,
  judge,
  plan,
}: Pick<PurposeCheckControl, "on" | "judge" | "plan">): string {
  if (!on) return WHY;
  if (judge === "jev") return `${WHY} Checked by Jev.`;
  if (judge === "fast") return `${WHY} Checked by your fast model.`;
  const needs =
    plan === CLAUDE_CODE
      ? " with Claude Code"
      : plan
        ? " with the ChatGPT plan"
        : " or a fast model";
  return `${WHY} Needs a Jev key${needs}.`;
}

export function PurposeCheck({ control }: { control: PurposeCheckControl }) {
  const { on, judge, addJevKey } = control;
  return (
    <Group>
      <Switch
        className="ui-group-row"
        label="Purpose check"
        description={purposeDescription(control)}
        checked={on}
        onCheckedChange={control.change}
      />
      {addJevKey && (
        <Collapse open={on && judge !== "jev"}>
          <GroupRow
            label="Add a Jev key"
            detail={judge === "fast" ? "Quicker checks. It goes in Keys." : "It goes in Keys."}
            onSelect={addJevKey}
          />
        </Collapse>
      )}
    </Group>
  );
}
