import type { AgentRoleChoice, ModelOptions, ReasoningEffort } from "@localdot/protocol";
import { modelControls } from "@localdot/providers";
import { EffortSlider } from "../ui/EffortSlider.tsx";
import { Field } from "../ui/Field.tsx";
import { Select } from "../ui/Select.tsx";

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
        : "";
}
// What more thinking costs, or why the model offers no controls: a note under its rows.
export function optionsNote(choice: AgentRoleChoice, compact = false): string {
  if (!modelControls(choice.provider, choice.model).wire)
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
}: {
  choice: AgentRoleChoice;
  onChange(choice: AgentRoleChoice): void;
  outputLimit?: number;
  compact?: boolean;
}) {
  const controls = modelControls(choice.provider, choice.model);
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
        <p className="model-options-note">{optionsNote(choice, true)}</p>
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
