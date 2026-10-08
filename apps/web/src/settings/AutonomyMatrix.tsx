import { AutonomyMode, AutonomyPolicy, type EDITABLE_ACTION_CLASSES } from "@localdot/protocol";
import { Badge } from "../ui/Badge.tsx";
import { Field } from "../ui/Field.tsx";
import { Icon } from "../ui/Icon.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";

type Editable = (typeof EDITABLE_ACTION_CLASSES)[number];

const LABELS: Record<Editable, string> = {
  reading: "Read information",
  browsing: "Browse websites",
  purchase: "Make purchases",
  send: "Send messages",
  post: "Publish posts",
  delete: "Delete files or data",
  download_execute: "Download and run files",
  system_settings: "Change system settings",
};

const GROUPS: readonly { label: string; rows: readonly Editable[] }[] = [
  { label: "Low risk", rows: ["reading", "browsing"] },
  {
    label: "Consequential",
    rows: ["download_execute", "send", "post", "delete", "system_settings", "purchase"],
  },
];

const MODES = [
  { value: "act", label: "Just do it" },
  { value: "ask", label: "Ask me" },
  { value: "handoff", label: "I'll do it" },
] as const;

const LOCKED = [
  { label: "Passwords, codes and card details", mode: "I'll do it" },
  { label: "Steps dot can't classify", mode: "Ask me" },
] as const;

export interface AutonomyMatrixProps {
  value: AutonomyPolicy;
  // What is saved now, so a changed row can say so.
  saved?: AutonomyPolicy;
  onChange(value: AutonomyPolicy): void;
}

export function AutonomyMatrix({ value, saved, onChange }: AutonomyMatrixProps) {
  const parsed = AutonomyPolicy.safeParse(value);
  if (!parsed.success)
    return (
      <p role="alert" className="settings-note">
        These choices couldn't be read. Revert to load the saved ones.
      </p>
    );
  const policy = parsed.data;
  return (
    <div className="settings-autonomy">
      <p className="settings-note">
        Just do it: dot goes ahead. Ask me: dot waits for your OK. I'll do it: you take over.
      </p>
      {GROUPS.map((group) => (
        <div key={group.label} className="settings-autonomy-group">
          <h4 className="settings-group-title">{group.label}</h4>
          {group.rows.map((key) => {
            const changed = !!saved && saved[key] !== policy[key];
            return (
              <Field key={key} className="settings-autonomy-row" label={LABELS[key]}>
                {changed && (
                  <Badge className="settings-changed" kind="dot" tone="attention" label="Changed" />
                )}
                <SegmentedControl
                  value={policy[key]}
                  items={MODES}
                  onValueChange={(next) => {
                    const mode = AutonomyMode.safeParse(next);
                    if (mode.success)
                      onChange(AutonomyPolicy.parse({ ...policy, [key]: mode.data }));
                  }}
                />
              </Field>
            );
          })}
        </div>
      ))}
      <div className="settings-autonomy-group">
        <h4 className="settings-group-title">Always the same</h4>
        <ul className="settings-locked">
          {LOCKED.map((row) => (
            <li key={row.label}>
              <Icon name="lock" size={12} />
              <span>{row.label}</span>
              <span className="settings-locked-mode">{row.mode}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
