import type { MissedPolicy, RoutineNotify, RoutineProfile } from "@localdot/protocol";
import { Chip } from "../ui/Chip.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote } from "../ui/Group.tsx";
import { MoneyField } from "../ui/MoneyField.tsx";
import { RadioCards } from "../ui/RadioCards.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextArea } from "../ui/TextArea.tsx";
import { TextField } from "../ui/TextField.tsx";
import { AWAY, MISSED, NOTIFY, waitText } from "./routine-copy.ts";
import {
  EVERY,
  type FormErrors,
  type RoutineFormState,
  WEEK,
  WHEN_KINDS,
  type WhenKind,
  WINDOWS,
} from "./routine-form.ts";

export interface RoutineFormProps {
  value: RoutineFormState;
  errors: FormErrors;
  // The Mac's own clock, which every time here is on.
  zone: string;
  onChange(next: RoutineFormState): void;
}

const zoneName = (tz: string) =>
  tz === "UTC" || tz === "Etc/UTC" ? "UTC" : (tz.split("/").at(-1) ?? tz).replaceAll("_", " ");

// What a routine does, when, and how it behaves while you're away, in one scroll.
export function RoutineForm({ value, errors, zone, onChange }: RoutineFormProps) {
  const set = <K extends keyof RoutineFormState>(key: K, next: RoutineFormState[K]) =>
    onChange({ ...value, [key]: next });
  const timed = value.kind !== "custom";
  return (
    <div className="routine-form">
      <Field label="Name" error={errors.name}>
        <TextField
          value={value.name}
          maxLength={80}
          autoComplete="off"
          placeholder="Morning inbox"
          onChange={(event) => set("name", event.target.value)}
        />
      </Field>
      <Field
        label="What dot does"
        description="Write it the way you'd ask dot in the chat."
        error={errors.instruction}
      >
        <TextArea
          value={value.instruction}
          maxLength={8000}
          maxRows={8}
          placeholder="Check my inbox and tell me what needs a reply."
          onChange={(event) => set("instruction", event.target.value)}
        />
      </Field>

      <div>
        <GroupHead title="When" />
        <Group>
          <Field label="Repeats" inline className="ui-group-row">
            <Select
              appearance="inline"
              value={value.kind}
              items={WHEN_KINDS}
              onValueChange={(kind) => set("kind", kind as WhenKind)}
            />
          </Field>
          {value.kind === "weekly" && (
            <Field label="On" inline className="ui-group-row" error={errors.days}>
              <span className="routine-days">
                {WEEK.map(({ day, short, long }) => {
                  const on = value.days.includes(day);
                  return (
                    <Chip
                      key={day}
                      variant={on ? "filled" : "outline"}
                      aria-pressed={on}
                      aria-label={long}
                      onClick={() =>
                        set(
                          "days",
                          on ? value.days.filter((each) => each !== day) : [...value.days, day],
                        )
                      }
                    >
                      {short}
                    </Chip>
                  );
                })}
              </span>
            </Field>
          )}
          {value.kind === "once" && (
            <Field label="Date" inline className="ui-group-row" error={errors.date}>
              <TextField
                size="sm"
                type="date"
                value={value.date}
                onChange={(event) => set("date", event.target.value)}
              />
            </Field>
          )}
          {value.kind === "hours" && (
            <Field label="Every" inline className="ui-group-row">
              <Select
                appearance="inline"
                value={value.every}
                items={EVERY.map((hours) => ({
                  value: hours,
                  label: hours === "1" ? "Hour" : `${hours} hours`,
                }))}
                onValueChange={(every) => set("every", every)}
              />
            </Field>
          )}
          {timed && (
            <Field
              label={value.kind === "hours" ? "Starting at" : "At"}
              inline
              className="ui-group-row"
              error={errors.time}
            >
              <TextField
                size="sm"
                type="time"
                value={value.time}
                onChange={(event) => set("time", event.target.value)}
              />
            </Field>
          )}
          {value.kind === "custom" && (
            <Field
              label="Rule"
              className="ui-group-row"
              description="For example FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=9"
              error={errors.rule}
            >
              <TextField
                size="sm"
                value={value.rule}
                spellCheck={false}
                autoComplete="off"
                maxLength={256}
                onChange={(event) => set("rule", event.target.value)}
              />
            </Field>
          )}
          {value.kind !== "once" && (
            <>
              <Switch
                className="ui-group-row"
                label="Stop on a date"
                checked={value.ends}
                onCheckedChange={(ends) => set("ends", ends)}
              />
              <Collapse open={value.ends}>
                <Field label="Last day" inline className="ui-group-row" error={errors.until}>
                  <TextField
                    size="sm"
                    type="date"
                    value={value.until}
                    onChange={(event) => set("until", event.target.value)}
                  />
                </Field>
              </Collapse>
            </>
          )}
        </Group>
        <GroupNote>Times are on this Mac's clock ({zoneName(zone)} time).</GroupNote>
      </div>

      <div>
        <GroupHead title="While you're away" />
        <RadioCards
          layout="rows"
          name="routine-away"
          value={value.profile}
          options={(Object.keys(AWAY) as RoutineProfile[]).map((profile) => ({
            value: profile,
            label: AWAY[profile].label,
            description: AWAY[profile].description,
            ...(profile === "ask_first" ? { tag: "Recommended" } : {}),
          }))}
          onValueChange={(profile) => set("profile", profile as RoutineProfile)}
        />
      </div>

      <div>
        <GroupHead title="Details" />
        <Group>
          <Field label="Tell me" inline className="ui-group-row">
            <Select
              appearance="inline"
              value={value.notify}
              items={(Object.keys(NOTIFY) as RoutineNotify[]).map((notify) => ({
                value: notify,
                label: NOTIFY[notify],
              }))}
              onValueChange={(notify) => set("notify", notify as RoutineNotify)}
            />
          </Field>
          <Field label="If a run is missed" inline className="ui-group-row">
            <SegmentedControl
              size={24}
              value={value.missedPolicy}
              items={(Object.keys(MISSED) as MissedPolicy[]).map((policy) => ({
                value: policy,
                label: policy === "run_once" ? "Run once later" : MISSED[policy],
              }))}
              onValueChange={(policy) => set("missedPolicy", policy as MissedPolicy)}
            />
          </Field>
          <Field label="Wait for my answer" inline className="ui-group-row">
            <Select
              appearance="inline"
              value={value.windowMinutes}
              items={WINDOWS.map((minutes) => ({
                value: minutes,
                label: waitText(Number(minutes)),
              }))}
              onValueChange={(minutes) => set("windowMinutes", minutes)}
            />
          </Field>
          <Switch
            className="ui-group-row"
            label="Spending limit per run"
            description={
              value.limited
                ? "The run ends when it reaches this"
                : "Off: it follows your usual spending settings"
            }
            checked={value.limited}
            onCheckedChange={(limited) =>
              onChange({ ...value, limited, budget: value.budget || "1.00" })
            }
          />
          <Collapse open={value.limited}>
            <Field label="Per run" inline className="ui-group-row" error={errors.budget}>
              <MoneyField
                size="sm"
                value={value.budget}
                maxLength={6}
                onValueChange={(budget) => set("budget", budget)}
              />
            </Field>
          </Collapse>
        </Group>
        <GroupNote>
          A missed run is one due while your Mac was asleep or localDot wasn't running. If dot needs
          you and nobody answers in time, that run stops and says so.
        </GroupNote>
      </div>
    </div>
  );
}
