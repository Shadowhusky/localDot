import {
  type ActionClass,
  AutonomyMode,
  AutonomyPolicy,
  type EDITABLE_ACTION_CLASSES,
} from "@localdot/protocol";
import {
  AUTONOMY_PRESETS,
  CLASS_LABELS,
  CUSTOM_SUMMARY,
  checksSummary,
  presetOf,
} from "../copy/autonomy.ts";
import { Badge } from "../ui/Badge.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote, GroupRow, IconTile } from "../ui/Group.tsx";
import { Icon } from "../ui/Icon.tsx";
import type { IconName } from "../ui/icons.ts";
import { RadioCards } from "../ui/RadioCards.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
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
}

// How often dot stops to ask: a preset as one of a few rows, and every kind of action one level
// deeper for anyone who wants their own mix.
export function AutonomyMatrix({ value, saved, onChange }: AutonomyMatrixProps) {
  const parsed = AutonomyPolicy.safeParse(value);
  if (!parsed.success)
    return (
      <p role="alert" className="settings-lede">
        These choices couldn't be read. Revert to load the saved ones.
      </p>
    );
  const policy = parsed.data;
  const active = presetOf(policy);
  return (
    <div className="settings-autonomy">
      <div>
        <RadioCards
          aria-label="Start from"
          value={active?.name ?? ""}
          options={[...AUTONOMY_PRESETS].reverse().map((preset) => ({
            value: preset.name,
            label: preset.label,
            tag: preset.recommended ? "Recommended" : undefined,
            description: preset.summary,
          }))}
          onValueChange={(name) => {
            const preset = AUTONOMY_PRESETS.find((each) => each.name === name);
            if (preset) onChange(AutonomyPolicy.parse({ ...preset.policy }));
          }}
        />
        <GroupNote>
          {active ? "" : `${CUSTOM_SUMMARY} `}
          {checksSummary(policy)} Uploads and unclear steps always ask first, and passwords, codes
          and card details are always yours to enter.
        </GroupNote>
      </div>
      <Disclosure summary="Choose for each kind of action" className="settings-matrix">
        <p className="settings-lede settings-matrix-key">
          Just do it: dot goes ahead. Ask me: dot waits for your OK. I'll do it: you take over.
        </p>
        {GROUPS.map((group) => (
          <div key={group.label}>
            <GroupHead title={group.label} />
            <Group>
              {group.rows.map((key) => {
                const changed = !!saved && saved[key] !== policy[key];
                return (
                  <Field
                    key={key}
                    className="ui-group-row settings-autonomy-row"
                    label={CLASS_LABELS[key]}
                    inline
                  >
                    {changed && (
                      <Badge
                        className="settings-changed"
                        kind="dot"
                        tone="attention"
                        label="Changed"
                      />
                    )}
                    <SegmentedControl
                      size={24}
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
            </Group>
          </div>
        ))}
        <div>
          <GroupHead title="Always the same" />
          <Group>
            <ul className="settings-locked" aria-label="Always the same">
              {locked(policy).map(([key, mode]) => (
                <li key={key} className="ui-group-row">
                  <span>{CLASS_LABELS[key]}</span>
                  <span className="settings-locked-mode">{mode}</span>
                </li>
              ))}
            </ul>
          </Group>
          <GroupNote>
            Always allow can cover uploads and unclear steps for one task only. Once you sign in on
            its computer, commands count as unclear steps.
          </GroupNote>
        </div>
      </Disclosure>
    </div>
  );
}

const RULE_ICON: Partial<Record<ActionClass, IconName>> = {
  download_execute: "download",
  upload: "share",
  credentials: "lock",
  memory: "book",
  computer: "monitor",
};

// The choices made with Always allow on a request, each removable.
export function AlwaysAllowed({ rules }: { rules: RulesView }) {
  const busy = rules.removing !== null || rules.resetting;
  const wait = busy ? "Wait for the other change to finish" : undefined;
  return (
    <div className="settings-rules">
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
        <Group>
          <GroupRow
            label="Couldn't load this list."
            trailing={
              <Button variant="quiet" size="sm" onClick={rules.reload}>
                Try again
              </Button>
            }
          />
        </Group>
      ) : rules.rules.length ? (
        <Group>
          <ul className="settings-rule-list" aria-label="Always allowed">
            {rules.rules.map((rule) => {
              const name = CLASS_LABELS[rule.actionClass];
              return (
                <li key={rule.id}>
                  <GroupRow
                    leading={<IconTile icon={RULE_ICON[rule.actionClass] ?? "globe"} />}
                    label={name}
                    detail={rule.label}
                    trailing={
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
                    }
                  >
                    {rules.failed === rule.id && (
                      <p className="settings-rule-failed" role="status">
                        <Icon name="circle-alert" size={12} />
                        Couldn't remove this. Try again.
                      </p>
                    )}
                  </GroupRow>
                </li>
              );
            })}
          </ul>
        </Group>
      ) : rules.phase === "loading" ? (
        <Group aria-busy="true">
          <GroupRow
            label={<Skeleton loading width="16ch" />}
            detail={<Skeleton loading width="24ch" />}
          />
        </Group>
      ) : (
        !rules.unreadable && (
          <Group>
            <GroupRow label="Nothing yet. Use Always allow on a request to add one." />
          </Group>
        )
      )}
      <GroupNote>
        Rules come from Always allow on a request. dot never asks again inside a rule, and removing
        one takes effect right away.
      </GroupNote>
    </div>
  );
}
