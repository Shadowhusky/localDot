import {
  LAST_DAY,
  type MissedPolicy,
  type RoutineNotify,
  type RoutineProfile,
  SCHEDULE_LIMITS,
  type ScheduleUnit,
  zoneText,
} from "@localdot/protocol";
import { useId, useMemo } from "react";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Combobox } from "../ui/Combobox.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote } from "../ui/Group.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { MoneyField } from "../ui/MoneyField.tsx";
import { RadioCards } from "../ui/RadioCards.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextArea } from "../ui/TextArea.tsx";
import { TextField } from "../ui/TextField.tsx";
import { AWAY, MISSED, NOTIFY, waitText, whenText } from "./routine-copy.ts";
import {
  addedSchedule,
  type FormErrors,
  previewOf,
  type RoutineFormState,
  type ScheduleErrors,
  type ScheduleFormState,
  UNITS,
  WEEK,
  WINDOWS,
  withUnit,
} from "./routine-form.ts";

export interface RoutineFormProps {
  value: RoutineFormState;
  errors: FormErrors;
  // The Mac's own clock, which a new routine's times are on.
  zone: string;
  onChange(next: RoutineFormState): void;
}

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

function zones(current: string): readonly { value: string; label: string }[] {
  const known = Intl.supportedValuesOf("timeZone");
  return (known.includes(current) ? known : [current, ...known]).map((zone) => ({
    value: zone,
    label: zone.replaceAll("_", " "),
  }));
}

const toggled = (items: readonly number[], item: number) =>
  items.includes(item) ? items.filter((each) => each !== item) : [...items, item];

function Weekdays({
  value,
  error,
  onChange,
}: {
  value: readonly number[];
  error?: string;
  onChange(next: number[]): void;
}) {
  return (
    <Field label="On" className="ui-group-row" error={error}>
      <span className="routine-days">
        {WEEK.map(({ day, short, long }) => {
          const on = value.includes(day);
          return (
            <Chip
              key={day}
              variant={on ? "filled" : "outline"}
              aria-pressed={on}
              aria-label={long}
              onClick={() => onChange(toggled(value, day))}
            >
              {short}
            </Chip>
          );
        })}
      </span>
    </Field>
  );
}

function MonthDays({
  value,
  error,
  onChange,
}: {
  value: readonly number[];
  error?: string;
  onChange(next: number[]): void;
}) {
  const chip = (day: number, label: string, name: string) => {
    const on = value.includes(day);
    return (
      <Chip
        key={day}
        variant={on ? "filled" : "outline"}
        aria-pressed={on}
        aria-label={name}
        onClick={() => onChange(toggled(value, day))}
      >
        {label}
      </Chip>
    );
  };
  return (
    <Field
      label="On"
      className="ui-group-row"
      error={error}
      description={
        value.some((day) => day > 28) ? "A month without that day is passed over." : undefined
      }
    >
      <span className="routine-days" data-month="">
        {MONTH_DAYS.map((day) => chip(day, String(day), `Day ${day}`))}
        {chip(LAST_DAY, "Last", "The last day of the month")}
      </span>
    </Field>
  );
}

function Times({
  value,
  error,
  onChange,
}: {
  value: readonly string[];
  error?: string;
  onChange(next: string[]): void;
}) {
  // The field's label goes with the first; each control needs its own id.
  const others = useId();
  return (
    <Field label="At" inline className="ui-group-row" error={error}>
      <span className="routine-times">
        {value.map((time, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a time's place is its identity while it is typed
          <span className="routine-time" key={index}>
            <TextField
              size="sm"
              type="time"
              id={index ? `${others}${index}` : undefined}
              aria-label={value.length > 1 ? `Time ${index + 1}` : "Time"}
              value={time}
              onChange={(event) =>
                onChange(value.map((each, at) => (at === index ? event.target.value : each)))
              }
            />
            {value.length > 1 && (
              <IconButton
                icon="x"
                label={`Remove time ${index + 1}`}
                onClick={() => onChange(value.filter((_, at) => at !== index))}
              />
            )}
          </span>
        ))}
        {value.length < SCHEDULE_LIMITS.times && (
          <Button
            variant="quiet"
            size="sm"
            icon="plus"
            onClick={() => onChange([...value, value.at(-1) ?? "09:00"])}
          >
            Add time
          </Button>
        )}
      </span>
    </Field>
  );
}

// One rule: how often, which days, and when in the day.
function ScheduleRows({
  value,
  errors = {},
  onChange,
  onRemove,
}: {
  value: ScheduleFormState;
  errors?: ScheduleErrors;
  onChange(next: ScheduleFormState): void;
  onRemove?(): void;
}) {
  const within = value.unit === "minute" || value.unit === "hour";
  const period = useId();
  const set = <K extends keyof ScheduleFormState>(key: K, next: ScheduleFormState[K]) =>
    onChange({ ...value, [key]: next });
  return (
    <Group className="routine-schedule">
      <Field label="Every" inline className="ui-group-row" error={errors.every}>
        <span className="routine-every">
          <TextField
            size="sm"
            className="routine-every-count"
            inputMode="numeric"
            aria-label="How many"
            value={value.every}
            maxLength={3}
            onChange={(event) => set("every", event.target.value.replace(/\D/g, ""))}
          />
          <Select
            appearance="inline"
            id={period}
            aria-label="Period"
            value={value.unit}
            items={UNITS.map(({ value: unit, one, many }) => ({
              value: unit,
              label: value.every === "1" ? one : many,
            }))}
            onValueChange={(unit) => onChange(withUnit(value, unit as ScheduleUnit))}
          />
          {onRemove && <IconButton icon="trash" label="Remove this schedule" onClick={onRemove} />}
        </span>
      </Field>
      {value.unit === "month" ? (
        <MonthDays
          value={value.monthDays}
          error={errors.days}
          onChange={(days) => set("monthDays", days)}
        />
      ) : (
        <Weekdays
          value={value.weekdays}
          error={errors.days}
          onChange={(days) => set("weekdays", days)}
        />
      )}
      {within ? (
        <>
          <Field label="From" inline className="ui-group-row">
            <TextField
              size="sm"
              type="time"
              value={value.from}
              onChange={(event) => set("from", event.target.value)}
            />
          </Field>
          <Field label="Until" inline className="ui-group-row" error={errors.span}>
            <TextField
              size="sm"
              type="time"
              value={value.to}
              onChange={(event) => set("to", event.target.value)}
            />
          </Field>
        </>
      ) : (
        <Times value={value.times} error={errors.times} onChange={(times) => set("times", times)} />
      )}
    </Group>
  );
}

// The schedule in plain words and its next few runs, as the form stands.
function RunsPreview({ form }: { form: RoutineFormState }) {
  const now = Date.now();
  // biome-ignore lint/correctness/useExhaustiveDependencies: what it says changes with the form, not by the second
  const preview = useMemo(() => previewOf(form, now), [form]);
  if (!preview)
    return (
      <p className="routine-preview routine-preview-note">
        Finish the schedule to see when it runs.
      </p>
    );
  return (
    <div className="routine-preview">
      <p className="routine-preview-summary" role="status">
        {preview.summary}
      </p>
      {preview.runs.length ? (
        <ol className="routine-preview-runs" aria-label="Next runs">
          {preview.runs.map((run) => (
            <li key={run}>
              <time className="num" dateTime={new Date(run).toISOString()}>
                {whenText(run, form.tz, now)}
              </time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="routine-preview-note">No runs are left on those dates.</p>
      )}
    </div>
  );
}

// What a routine does, when, and how it behaves while you're away, in one scroll.
export function RoutineForm({ value, errors, zone, onChange }: RoutineFormProps) {
  const set = <K extends keyof RoutineFormState>(key: K, next: RoutineFormState[K]) =>
    onChange({ ...value, [key]: next });
  const setSchedule = (id: string, next: ScheduleFormState) =>
    set(
      "schedules",
      value.schedules.map((each) => (each.id === id ? next : each)),
    );
  const zoneItems = useMemo(() => zones(value.tz), [value.tz]);
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

      <div className="routine-when">
        <GroupHead title="When" />
        <Group>
          <Field label="Runs" inline className="ui-group-row">
            <SegmentedControl
              size={24}
              value={value.once ? "once" : "repeat"}
              items={[
                { value: "repeat", label: "On a schedule" },
                { value: "once", label: "Once" },
              ]}
              onValueChange={(runs) => set("once", runs === "once")}
            />
          </Field>
          {value.once && (
            <>
              <Field label="Date" inline className="ui-group-row" error={errors.date}>
                <TextField
                  size="sm"
                  type="date"
                  value={value.date}
                  onChange={(event) => set("date", event.target.value)}
                />
              </Field>
              <Times
                value={value.onceTimes}
                error={errors.times}
                onChange={(times) => set("onceTimes", times)}
              />
            </>
          )}
        </Group>
        {!value.once && (
          <>
            {value.schedules.map((schedule) => (
              <ScheduleRows
                key={schedule.id}
                value={schedule}
                errors={errors.schedules?.[schedule.id]}
                onChange={(next) => setSchedule(schedule.id, next)}
                onRemove={
                  value.schedules.length > 1
                    ? () =>
                        set(
                          "schedules",
                          value.schedules.filter((each) => each.id !== schedule.id),
                        )
                    : undefined
                }
              />
            ))}
            {value.schedules.length < SCHEDULE_LIMITS.schedules && (
              <span className="routine-add-schedule">
                <Button
                  size="sm"
                  icon="plus"
                  onClick={() =>
                    set("schedules", [...value.schedules, addedSchedule(value.schedules)])
                  }
                >
                  Add another schedule
                </Button>
              </span>
            )}
          </>
        )}
        <Group>
          {!value.once && (
            <>
              <Field label="Starts" inline className="ui-group-row" error={errors.start}>
                <TextField
                  size="sm"
                  type="date"
                  value={value.start}
                  onChange={(event) => set("start", event.target.value)}
                />
              </Field>
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
          <Field label="Time zone" inline className="ui-group-row">
            <Combobox
              appearance="inline"
              searchPlaceholder="Search time zones"
              value={value.tz}
              items={zoneItems}
              onValueChange={(tz) => set("tz", tz)}
            />
          </Field>
        </Group>
        <GroupNote>
          {value.tz === zone
            ? `Times are on this Mac's clock (${zoneText(zone)}).`
            : `Times are in ${zoneText(value.tz)}, not this Mac's clock (${zoneText(zone)}).`}{" "}
          They stay put when the clocks change.
        </GroupNote>
        <RunsPreview form={value} />
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
