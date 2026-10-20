import type {
  AgentRoleChoice,
  ModelControls,
  ModelOptions,
  ReasoningEffort,
} from "@localdot/protocol";
import { modelControls } from "@localdot/providers";
import { EffortSlider } from "../ui/EffortSlider.tsx";
import { Field } from "../ui/Field.tsx";
import { Select } from "../ui/Select.tsx";
import type { SubscriptionModel } from "./choices.ts";

export const effortLabel = (value?: string) =>
  value === "none"
    ? "Off"
    : value === "enabled"
      ? "On"
      : value === "xhigh"
        ? "Extra high"
        : value === "max"
          ? "Maximum"
          : value
            ? value.charAt(0).toUpperCase() + value.slice(1)
            : "Provider default";
export function optionsLabel(options?: ModelOptions): string {
  return options?.thinkingBudget
    ? `${options.thinkingBudget.toLocaleString()} thinking tokens`
    : options?.reasoningEffort
      ? effortLabel(options.reasoningEffort)
      : options?.verbosity
        ? `${effortLabel(options.verbosity)} detail`
        : options?.speed === "fast"
          ? "Fast"
          : options?.speed === "standard"
            ? "Standard speed"
            : "";
}
// What more thinking costs, or why the model offers no controls: a note under its rows.
export function optionsNote(
  choice: AgentRoleChoice,
  compact = false,
  discovered?: ModelControls,
): string {
  if (!modelControls(choice.provider, choice.model, discovered).wire)
    return "This model uses its provider defaults. No adjustable reasoning controls are verified for this endpoint.";
  return compact
    ? "More thinking may take longer."
    : "More thinking can take longer and use more tokens.";
}

// A model's reasoning controls: pop-up rows of a settings group, or sliders in the composer's panel.
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
  const base = modelControls(
    choice.provider,
    accountModel?.resolvedModel ?? choice.model,
    discovered,
  );
  const controls = {
    ...base,
    efforts: accountModel?.efforts ?? base.efforts,
    speeds:
      accountModel?.fast === false || (choice.provider === "chatgpt" && accountModel?.fast !== true)
        ? undefined
        : accountModel?.fast === true
          ? (["standard", "fast"] as const)
          : base.speeds,
  };
  const options = choice.options ?? {};
  const change = (patch: Partial<ModelOptions>) => {
    const next = Object.fromEntries(
      Object.entries({ ...options, ...patch }).filter(([, value]) => value !== undefined),
    );
    onChange({ ...choice, options: Object.keys(next).length ? next : undefined });
  };
  const items = [
    { value: "", label: "Provider default" },
    ...controls.efforts.map((value) => ({ value, label: effortLabel(value) })),
  ];
  const changeEffort = (value: string) =>
    change({
      reasoningEffort: (value || undefined) as ReasoningEffort | undefined,
      thinkingBudget: undefined,
    });
  const detailItems = [
    { value: "", label: "Provider default" },
    { value: "low", label: "Concise" },
    { value: "medium", label: "Balanced" },
    { value: "high", label: "Detailed" },
  ];
  const changeDetail = (value: string) =>
    change({ verbosity: (value || undefined) as ModelOptions["verbosity"] });
  const speed = controls.speeds && (
    <Field label="Speed" inline className={compact ? "model-speed-field" : "ui-group-row"}>
      <Select
        appearance="inline"
        value={options.speed ?? ""}
        items={[
          { value: "", label: "Provider default" },
          { value: "standard", label: "Standard" },
          { value: "fast", label: "Fast · higher cost" },
        ]}
        onValueChange={(value) => change({ speed: (value || undefined) as ModelOptions["speed"] })}
      />
    </Field>
  );
  if (compact)
    return (
      <div className="model-options-fields" data-compact="">
        {controls.efforts.length > 0 && (
          <EffortSlider
            value={options.reasoningEffort ?? ""}
            items={items}
            onChange={changeEffort}
          />
        )}
        {controls.verbosity && (
          <EffortSlider
            label="Answer detail"
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
        <Field label="Reasoning effort" inline className="ui-group-row">
          <Select
            appearance="inline"
            value={options.reasoningEffort ?? ""}
            items={items}
            onValueChange={changeEffort}
          />
        </Field>
      )}
      {controls.budget && budgets.length > 0 && (
        <Field label="Thinking budget" inline className="ui-group-row">
          <Select
            appearance="inline"
            value={String(options.thinkingBudget ?? "")}
            items={[
              { value: "", label: "Provider default" },
              ...budgets.map((value) => ({
                value: String(value),
                label: `${value.toLocaleString()} tokens`,
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
        <Field label="Answer detail" inline className="ui-group-row">
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
