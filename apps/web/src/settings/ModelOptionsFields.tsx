import type {
  AgentRoleChoice,
  ModelControls,
  ModelOptions,
  PremiumSpeed,
  ReasoningEffort,
} from "@localdot/protocol";
import { choiceControls } from "@localdot/providers";
import { t, tr } from "../i18n/index.ts";
import { EffortSlider } from "../ui/EffortSlider.tsx";
import { Field } from "../ui/Field.tsx";
import { Select } from "../ui/Select.tsx";
import {
  controlsOf,
  premiumSpeed,
  SPEED_NAMES,
  type SubscriptionModel,
  speedCost,
} from "./choices.ts";

const EFFORT_NAMES = new Map<string, string>([
  ["none", tr("Off")],
  ["enabled", tr("On")],
  ["minimal", tr("Minimal")],
  ["low", tr("Low")],
  ["medium", tr("Medium")],
  ["high", tr("High")],
  ["xhigh", tr("Extra high")],
  ["max", tr("Maximum")],
  ["ultra", tr("Ultra")],
]);
const DETAIL_NAMES: Readonly<Record<NonNullable<ModelOptions["verbosity"]>, string>> = {
  low: tr("Low detail"),
  medium: tr("Medium detail"),
  high: tr("High detail"),
};
export const effortLabel = (value?: string) =>
  value
    ? (EFFORT_NAMES.get(value) ?? value.charAt(0).toUpperCase() + value.slice(1))
    : t`Provider default`;
// Thinking, in a word or two. Speed has its own mark beside it.
export function optionsLabel(options?: ModelOptions): string {
  return options?.thinkingBudget
    ? t`${options.thinkingBudget.toLocaleString()} thinking tokens`
    : options?.reasoningEffort
      ? effortLabel(options.reasoningEffort)
      : options?.verbosity
        ? DETAIL_NAMES[options.verbosity]
        : "";
}
// What more thinking costs, or why the model offers no controls: a note under its rows.
export function optionsNote(
  choice: AgentRoleChoice,
  compact = false,
  discovered?: ModelControls,
): string {
  if (!choiceControls(choice, discovered).wire)
    return t`This model uses its provider defaults. No adjustable reasoning controls are verified for this endpoint.`;
  return compact
    ? t`More thinking may take longer.`
    : t`More thinking can take longer and use more tokens.`;
}

// A model's reasoning controls and speed: pop-up rows of a settings group, or sliders in the
// composer's panel.
export function ModelOptionsFields({
  choice,
  onChange,
  outputLimit = 4096,
  compact = false,
  accountModel,
  discovered,
}: {
  choice: AgentRoleChoice;
  onChange(choice: AgentRoleChoice): void;
  outputLimit?: number;
  compact?: boolean;
  accountModel?: SubscriptionModel;
  discovered?: ModelControls;
}) {
  const controls = controlsOf(choice, accountModel, discovered);
  const options = choice.options ?? {};
  const change = (patch: Partial<ModelOptions>) => {
    const next = Object.fromEntries(
      Object.entries({ ...options, ...patch }).filter(([, value]) => value !== undefined),
    );
    onChange({ ...choice, options: Object.keys(next).length ? next : undefined });
  };
  // An On saved before the model offered levels is its default thinking (modelOptionsProblem).
  const effortValue =
    options.reasoningEffort === "enabled" && !controls.efforts.includes("enabled")
      ? ""
      : (options.reasoningEffort ?? "");
  const items = [
    { value: "", label: t`Provider default` },
    ...controls.efforts.map((value) => ({ value, label: effortLabel(value) })),
  ];
  const changeEffort = (value: string) =>
    change({
      reasoningEffort: (value || undefined) as ReasoningEffort | undefined,
      thinkingBudget: undefined,
    });
  const detailItems = [
    { value: "", label: t`Provider default` },
    { value: "low", label: t`Concise` },
    { value: "medium", label: t`Balanced` },
    { value: "high", label: t`Detailed` },
  ];
  const changeDetail = (value: string) =>
    change({ verbosity: (value || undefined) as ModelOptions["verbosity"] });
  const speed = controls.speeds.length > 0 && (
    <Field label={t`Speed`} inline className={compact ? "model-speed-field" : "ui-group-row"}>
      <Select
        appearance="inline"
        value={premiumSpeed(options) ?? ""}
        items={[
          { value: "", label: t`Standard` },
          ...controls.speeds.map((value) => ({
            value,
            label: SPEED_NAMES[value],
            description: speedCost(choice, value),
          })),
        ]}
        onValueChange={(value) => change({ speed: (value || undefined) as PremiumSpeed })}
      />
    </Field>
  );
  if (compact)
    return (
      <div className="model-options-fields" data-compact="">
        {controls.efforts.length > 0 && (
          <EffortSlider value={effortValue} items={items} onChange={changeEffort} />
        )}
        {controls.verbosity && (
          <EffortSlider
            label={t`Answer detail`}
            value={options.verbosity ?? ""}
            items={detailItems}
            onChange={changeDetail}
          />
        )}
        {speed}
        <p className="model-options-note">{optionsNote(choice, true, discovered)}</p>
      </div>
    );
  const budgets = [
    ...new Set([
      1024,
      2048,
      4096,
      8192,
      12288,
      ...(options.thinkingBudget ? [options.thinkingBudget] : []),
    ]),
  ]
    .sort((a, b) => a - b)
    .filter((value) => value <= Math.min(outputLimit, 16000) - 1024);
  return (
    <>
      {speed}
      {controls.efforts.length > 0 && (
        <Field label={t`Reasoning effort`} inline className="ui-group-row">
          <Select
            appearance="inline"
            value={effortValue}
            items={items}
            onValueChange={changeEffort}
          />
        </Field>
      )}
      {controls.budget && budgets.length > 0 && (
        <Field label={t`Thinking budget`} inline className="ui-group-row">
          <Select
            appearance="inline"
            value={String(options.thinkingBudget ?? "")}
            items={[
              { value: "", label: t`Provider default` },
              ...budgets.map((value) => ({
                value: String(value),
                label: t`${value.toLocaleString()} tokens`,
              })),
            ]}
            onValueChange={(value) =>
              change({
                thinkingBudget: value ? Number(value) : undefined,
                reasoningEffort: undefined,
              })
            }
          />
        </Field>
      )}
      {controls.verbosity && (
        <Field label={t`Answer detail`} inline className="ui-group-row">
          <Select
            appearance="inline"
            value={options.verbosity ?? ""}
            items={detailItems}
            onValueChange={changeDetail}
          />
        </Field>
      )}
    </>
  );
}
