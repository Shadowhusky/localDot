import { Collapse } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
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
    <div className="settings-autonomy-group">
      <h4 className="settings-group-title">Check in with me</h4>
      <p className="settings-note settings-check-ins-intro">
        Off unless you turn them on. Each count starts again when you send a message.
      </p>
      {CHECK_INS.map((row) => {
        const current = value[row.key];
        return (
          <div key={row.key} className="settings-check-in">
            <Switch
              label={row.label}
              description={row.description}
              checked={current.on}
              onCheckedChange={(on) => onChange(row.key, { ...current, on })}
            />
            <Collapse open={current.on}>
              <Field label={row.field} className="settings-check-in-field">
                <TextField
                  size="sm"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="off"
                  suffix={row.unit}
                  value={current.value}
                  onChange={(event) =>
                    onChange(row.key, { ...current, value: event.target.value.replace(/\D/g, "") })
                  }
                />
              </Field>
            </Collapse>
          </div>
        );
      })}
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
    <div className="settings-spending">
      <Switch
        label="Spending limit"
        description={
          value.on
            ? "dot pauses and asks you when it reaches a limit."
            : "Off: dot never stops or warns you about cost."
        }
        checked={value.on}
        onCheckedChange={(on) => onChange({ ...value, on })}
      />
      <Collapse open={value.on}>
        <div className="settings-price-fields">
          <Field label="Per task" description="Applies to new tasks.">
            <MoneyField
              value={value.task}
              maxLength={9}
              placeholder="No limit"
              onValueChange={(task) => onChange({ ...value, task })}
            />
          </Field>
          <Field label="Per day" description="Shared by every task.">
            <MoneyField
              value={value.day}
              maxLength={9}
              placeholder="No limit"
              onValueChange={(day) => onChange({ ...value, day })}
            />
          </Field>
        </div>
      </Collapse>
    </div>
  );
}
