import { Collapse } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote, GroupRow } from "../ui/Group.tsx";
import { MoneyField } from "../ui/MoneyField.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import type { CheckInKey, CheckInsDraft, SpendingDraft } from "./settings-form.ts";

const CHECK_INS: readonly {
  key: CheckInKey;
  label: string;
  description: string;
  field: string;
  unit: string;
}[] = [
  {
    key: "steps",
    label: "After a number of steps",
    description: "dot asks whether to keep going.",
    field: "Steps",
    unit: "steps",
  },
  {
    key: "failures",
    label: "After failed actions in a row",
    description: "dot asks whether to keep trying. Off, it tries another way by itself.",
    field: "Failed actions",
    unit: "in a row",
  },
  {
    key: "actions",
    label: "Stop after a number of actions",
    description: "A hard stop dot can't skip. Send a message to continue.",
    field: "Actions",
    unit: "actions",
  },
];

export function CheckIns({
  value,
  onChange,
}: {
  value: CheckInsDraft;
  onChange(key: CheckInKey, next: CheckInsDraft[CheckInKey]): void;
}) {
  return (
    <div>
      <GroupHead title="Check in with me" />
      <Group>
        {CHECK_INS.map((row) => {
          const current = value[row.key];
          return (
            <div key={row.key} className="settings-check-in">
              <Switch
                className="ui-group-row"
                label={row.label}
                description={row.description}
                checked={current.on}
                onCheckedChange={(on) => onChange(row.key, { ...current, on })}
              />
              <Collapse open={current.on}>
                <Field label={row.field} inline className="ui-group-row">
                  <TextField
                    size="sm"
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="off"
                    suffix={row.unit}
                    value={current.value}
                    onChange={(event) =>
                      onChange(row.key, {
                        ...current,
                        value: event.target.value.replace(/\D/g, ""),
                      })
                    }
                  />
                </Field>
              </Collapse>
            </div>
          );
        })}
      </Group>
      <GroupNote>
        Off unless you turn them on. Each count starts again when you send a message.
      </GroupNote>
    </div>
  );
}

export function SpendingLimits({
  value,
  onChange,
}: {
  value: SpendingDraft;
  onChange(next: SpendingDraft): void;
}) {
  return (
    <div>
      <Group>
        <Switch
          className="ui-group-row"
          label="Spending limit"
          description={value.on ? "On: dot pauses and asks you at a limit" : "Off: no limit"}
          checked={value.on}
          onCheckedChange={(on) => onChange({ ...value, on })}
        />
        <Collapse open={value.on}>
          <Field label="Per task" inline className="ui-group-row">
            <MoneyField
              size="sm"
              value={value.task}
              maxLength={9}
              placeholder="No limit"
              onValueChange={(task) => onChange({ ...value, task })}
            />
          </Field>
          <Field label="Per day" inline className="ui-group-row">
            <MoneyField
              size="sm"
              value={value.day}
              maxLength={9}
              placeholder="No limit"
              onValueChange={(day) => onChange({ ...value, day })}
            />
          </Field>
          <GroupRow label="When it's reached" trailing="Pause and ask me" />
        </Collapse>
      </Group>
      <GroupNote>
        {value.on
          ? "A task limit applies to new tasks; the day limit is shared by every task."
          : "Turn on to set a limit per task or per day. When dot reaches it, it pauses and asks you."}
      </GroupNote>
    </div>
  );
}
