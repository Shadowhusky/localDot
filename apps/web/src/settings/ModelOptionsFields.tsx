import type { AgentRoleChoice, ModelOptions, ReasoningEffort } from "@localdot/protocol";
import { modelControls } from "@localdot/providers";
import { Button } from "../ui/Button.tsx";
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
  const detailItems = [
    { value: "", label: "Provider default" },
    { value: "low", label: "Concise" },
    { value: "medium", label: "Balanced" },
    { value: "high", label: "Detailed" },
  ];
  const changeDetail = (value: string) =>
    change({ verbosity: (value || undefined) as ModelOptions["verbosity"] });
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
    <div className="model-options-fields" data-compact={compact || undefined}>
      {controls.efforts.length > 0 &&
        (compact ? (
          <EffortSlider
            value={options.reasoningEffort ?? ""}
            items={items}
            onChange={(value) =>
              change({
                reasoningEffort: (value || undefined) as ReasoningEffort | undefined,
                thinkingBudget: undefined,
              })
            }
          />
        ) : (
          <Field label="Reasoning effort" inline className="ui-group-row">
            <Select
              size="sm"
              value={options.reasoningEffort ?? ""}
              items={items}
              onValueChange={(value) =>
                change({
                  reasoningEffort: (value || undefined) as ReasoningEffort | undefined,
                  thinkingBudget: undefined,
                })
              }
            />
          </Field>
        ))}
      {controls.budget && budgets.length > 0 && (
        <Field label="Thinking budget" inline className="ui-group-row">
          <Select
            size="sm"
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
      {controls.verbosity &&
        (compact ? (
          <EffortSlider
            label="Answer detail"
            value={options.verbosity ?? ""}
            items={detailItems}
            onChange={changeDetail}
          />
        ) : (
          <Field label="Answer detail" inline className="ui-group-row">
            <Select
              size="sm"
              value={options.verbosity ?? ""}
              items={detailItems}
              onValueChange={changeDetail}
            />
          </Field>
        ))}
      <p className="model-options-note">
        {controls.wire
          ? compact
            ? "More thinking may take longer."
            : "More thinking can take longer and use more tokens. Your spending limits still apply."
          : "This model uses its provider defaults. No adjustable reasoning controls are verified for this endpoint."}
      </p>
      {!compact && Object.values(options).some((value) => value !== undefined) && (
        <Button
          variant="quiet"
          size="sm"
          onClick={() => onChange({ ...choice, options: undefined })}
        >
          Reset to provider defaults
        </Button>
      )}
    </div>
  );
}
