import {
  type ActionClass,
  AutonomyMode,
  AutonomyPolicy,
  type EDITABLE_ACTION_CLASSES,
} from "@localdot/protocol";
import { AUTONOMY_PRESETS, CLASS_LABELS, CUSTOM_SUMMARY, presetOf } from "../copy/autonomy.ts";
import { Badge } from "../ui/Badge.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { Icon } from "../ui/Icon.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import type { RulesView } from "./useRules.ts";

type Editable = (typeof EDITABLE_ACTION_CLASSES)[number];

export const GROUPS: readonly { label: string; rows: readonly Editable[] }[] = [
  {
    label: "Its own work",
    rows: ["reading", "browsing", "computer", "download_execute", "memory"],
  },
  { label: "Acting as you", rows: ["send", "post", "delete", "system_settings", "purchase"] },
];

const MODES = [
  { value: "act", label: "Just do it" },
  { value: "ask", label: "Ask me" },
  { value: "handoff", label: "I'll do it" },
] as const;

const lower = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

const NOTES = [
  ...AUTONOMY_PRESETS.map((preset) => ({
    name: preset.name,
    text: preset.recommended ? `Recommended: ${lower(preset.summary)}` : preset.summary,
  })),
  { name: "", text: `Custom: ${lower(CUSTOM_SUMMARY)}` },
];

const locked = (policy: AutonomyPolicy): readonly [ActionClass, string][] => [
  ["upload", policy.send === "handoff" ? "I'll do it, like sending" : "Ask me"],
  ["credentials", "I'll do it"],
  ["unknown", "Ask me"],
];

export interface AutonomyMatrixProps {
  value: AutonomyPolicy;
  // What is saved now, so a changed row can say so.
  saved?: AutonomyPolicy;
  onChange(value: AutonomyPolicy): void;
  rules?: RulesView;
}

export function AutonomyMatrix({ value, saved, onChange, rules }: AutonomyMatrixProps) {
  const parsed = AutonomyPolicy.safeParse(value);
  if (!parsed.success)
    return (
      <p role="alert" className="settings-note">
        These choices couldn't be read. Revert to load the saved ones.
      </p>
    );
  const policy = parsed.data;
  const active = presetOf(policy);
  return (
    <div className="settings-autonomy">
      <Field
        label="Start from"
        description={
          // Every note shares one cell, so switching between them never moves the rows below.
          <span className="settings-preset-notes">
            {NOTES.map((note) => (
              <span key={note.name} data-shown={note.name === (active?.name ?? "") || undefined}>
                {note.text}
              </span>
            ))}
          </span>
        }
      >
        <SegmentedControl
          value={active?.name ?? ""}
          items={AUTONOMY_PRESETS.map((preset) => ({ value: preset.name, label: preset.label }))}
          onValueChange={(name) => {
            const preset = AUTONOMY_PRESETS.find((each) => each.name === name);
            if (preset) onChange(AutonomyPolicy.parse({ ...preset.policy }));
          }}
        />
      </Field>
      <p className="settings-note">
        Just do it: dot goes ahead. Ask me: dot waits for your OK. I'll do it: you take over.
      </p>
      {GROUPS.map((group) => (
        <div key={group.label} className="settings-autonomy-group">
          <h4 className="settings-group-title">{group.label}</h4>
          {group.rows.map((key) => {
            const changed = !!saved && saved[key] !== policy[key];
            return (
              <Field key={key} className="settings-autonomy-row" label={CLASS_LABELS[key]} inline>
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
        <ul className="settings-locked" aria-label="Always the same">
          {locked(policy).map(([key, mode]) => (
            <li key={key}>
              <Icon name="lock" size={12} />
              <span>{CLASS_LABELS[key]}</span>
              <span className="settings-locked-mode">{mode}</span>
            </li>
          ))}
        </ul>
        <p className="settings-note settings-autonomy-hint">
          Always allow can cover uploads and unclear steps for one task only. Once you sign in on
          its computer, commands count as unclear steps.
        </p>
      </div>
      {rules && <AlwaysAllowed rules={rules} />}
    </div>
  );
}

function AlwaysAllowed({ rules }: { rules: RulesView }) {
  const busy = rules.removing !== null || rules.resetting;
  const wait = busy ? "Wait for the other change to finish" : undefined;
  return (
    <div className="settings-autonomy-group">
      <h4 className="settings-group-title">Always allowed</h4>
      <p className="settings-note settings-rules-intro">
        Choices you made with Always allow on a request. Removing one takes effect right away.
      </p>
      {rules.unreadable && (
        <Banner
          tone="attention"
          announce
          className="settings-rules-banner"
          title={rules.unreadable}
          actions={
            <Button
              size="sm"
              busy={rules.resetting}
              disabledReason={rules.resetting ? undefined : wait}
              onClick={rules.reset}
            >
              Start over
            </Button>
          }
        >
          Start over to save new choices. The old file is kept, not deleted.
          {rules.resetFailed && <span role="alert"> Couldn't start over. Try again.</span>}
        </Banner>
      )}
      {rules.phase === "error" ? (
        <div className="settings-inline">
          <p className="settings-note">Couldn't load this list.</p>
          <Button variant="quiet" size="sm" onClick={rules.reload}>
            Try again
          </Button>
        </div>
      ) : rules.rules.length ? (
        <ul className="settings-rules" aria-label="Always allowed">
          {rules.rules.map((rule) => {
            const name = CLASS_LABELS[rule.actionClass];
            return (
              <li key={rule.id}>
                <span className="settings-rule-text">
                  <span className="settings-rule-name">{name}</span>
                  <span className="settings-rule-where">{rule.label}</span>
                </span>
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label={`Remove ${name}: ${rule.label}`}
                  busy={rules.removing === rule.id}
                  disabledReason={rules.removing === rule.id ? undefined : wait}
                  onClick={() => rules.remove(rule.id)}
                >
                  Remove
                </Button>
                {rules.failed === rule.id && (
                  <p className="settings-rule-failed" role="status">
                    <Icon name="circle-alert" size={12} />
                    Couldn't remove this. Try again.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : rules.phase === "loading" ? (
        <p role="status" className="settings-note">
          Loading…
        </p>
      ) : (
        !rules.unreadable && (
          <p className="settings-note">Nothing yet. Use Always allow on a request to add one.</p>
        )
      )}
    </div>
  );
}
