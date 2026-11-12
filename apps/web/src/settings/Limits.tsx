import { ResearchBudget } from "@localdot/protocol";
import { t, tr } from "../i18n/index.ts";
import { Collapse } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote, GroupRow } from "../ui/Group.tsx";
import { MoneyField } from "../ui/MoneyField.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import type { CheckInKey, CheckInsDraft, ResearchDraft, SpendingDraft } from "./settings-form.ts";

const CHECK_INS: readonly {
  key: CheckInKey;
  label: string;
  description: string;
  field: string;
  unit: string;
}[] = [
  {
    key: "steps",
    label: tr("After a number of steps"),
    description: tr("dot asks whether to keep going."),
    field: tr("Steps"),
    unit: tr("steps"),
  },
  {
    key: "failures",
    label: tr("After failed actions in a row"),
    description: tr("dot asks whether to keep trying. Off, it tries another way by itself."),
    field: tr("Failed actions"),
    unit: tr("in a row"),
  },
  {
    key: "actions",
    label: tr("Stop after a number of actions"),
    description: tr("A hard stop dot can't skip. Send a message to continue."),
    field: tr("Actions"),
    unit: tr("actions"),
  },
];

// Only a field with something to say keeps a line for it.
const saying = (error: string | undefined) => (error ? { error } : {});

export function CheckIns({
  value,
  errors,
  onChange,
}: {
  value: CheckInsDraft;
  errors?: Partial<Record<CheckInKey, string>>;
  onChange(key: CheckInKey, next: CheckInsDraft[CheckInKey]): void;
}) {
  return (
    <div>
      <GroupHead title={t`Check in with me`} />
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
                <Field
                  label={row.field}
                  inline
                  className="ui-group-row"
                  {...saying(errors?.[row.key])}
                >
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
        {t`Off unless you turn them on. Each count starts again when you send a message.`}
      </GroupNote>
    </div>
  );
}

// How far a research task reads before it writes: a soft stop, with what it has.
export function ResearchLimits({
  value,
  error,
  onChange,
}: {
  value: ResearchDraft;
  error?: string;
  onChange(next: ResearchDraft): void;
}) {
  const digits = (raw: string) => raw.replace(/\D/g, "");
  const sourcesFit = ResearchBudget.shape.sources.safeParse(Number(value.sources || "x")).success;
  return (
    <div>
      <GroupHead title={t`Research`} />
      <Group>
        <Field
          label={t`Read up to`}
          inline
          className="ui-group-row"
          {...saying(sourcesFit ? undefined : error)}
        >
          <TextField
            size="sm"
            inputMode="numeric"
            maxLength={3}
            autoComplete="off"
            suffix={t`sources`}
            value={value.sources}
            onChange={(event) => onChange({ ...value, sources: digits(event.target.value) })}
          />
        </Field>
        <Field
          label={t`Take up to`}
          inline
          className="ui-group-row"
          {...saying(sourcesFit ? error : undefined)}
        >
          <TextField
            size="sm"
            inputMode="numeric"
            maxLength={3}
            autoComplete="off"
            suffix={t`minutes`}
            value={value.minutes}
            onChange={(event) => onChange({ ...value, minutes: digits(event.target.value) })}
          />
        </Field>
      </Group>
      <GroupNote>
        {t`Where dot stops reading and writes its report with what it has. While it works you can wrap up sooner or let it keep going.`}
      </GroupNote>
    </div>
  );
}

export function SpendingLimits({
  value,
  errors,
  onChange,
}: {
  value: SpendingDraft;
  errors?: { task?: string; day?: string };
  onChange(next: SpendingDraft): void;
}) {
  return (
    <div>
      <Group>
        <Switch
          className="ui-group-row"
          label={t`Spending limit`}
          description={value.on ? t`On: dot pauses and asks you at a limit` : t`Off: no limit`}
          checked={value.on}
          onCheckedChange={(on) => onChange({ ...value, on })}
        />
        <Collapse open={value.on}>
          <Field label={t`Per task`} inline className="ui-group-row" {...saying(errors?.task)}>
            <MoneyField
              size="sm"
              value={value.task}
              maxLength={9}
              placeholder={t`No limit`}
              onValueChange={(task) => onChange({ ...value, task })}
            />
          </Field>
          <Field label={t`Per day`} inline className="ui-group-row" {...saying(errors?.day)}>
            <MoneyField
              size="sm"
              value={value.day}
              maxLength={9}
              placeholder={t`No limit`}
              onValueChange={(day) => onChange({ ...value, day })}
            />
          </Field>
          <GroupRow label={t`When it's reached`} trailing={t`Pause and ask me`} />
        </Collapse>
      </Group>
      <GroupNote>
        {value.on
          ? t`A task limit applies to new tasks; the day limit is shared by every task.`
          : t`Turn on to set a limit per task or per day. When dot reaches it, it pauses and asks you.`}
      </GroupNote>
    </div>
  );
}
