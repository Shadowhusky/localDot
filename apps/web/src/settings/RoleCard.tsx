import { providerById } from "@localdot/providers";
import { useId } from "react";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import {
  type ModelRole,
  matchingKeys,
  type PickerKey,
  type ProviderModels,
  type RoleChoice,
  type SubscriptionModel,
} from "./choices.ts";
import { CHATGPT } from "./chooser.ts";
import { ModelChooser } from "./ModelChooser.tsx";

const ROLE: Record<ModelRole, { title: string; description: string }> = {
  main: { title: "Main model", description: "Does the work. It needs a model that can use tools." },
  fast: { title: "Fast model", description: "Optional. Writes titles and summaries." },
  local: {
    title: "Local model",
    description: "Optional. Runs in LM Studio or Ollama on this Mac.",
  },
};

const TIER: Record<string, string> = {
  native: "Computer use",
  "vision-tools": "Computer use",
  "text-only": "Tools",
  "no-tools": "Text only",
};

export interface RoleCardProps {
  modelRole: ModelRole;
  value?: RoleChoice;
  providers: readonly ProviderModels[];
  keys: readonly PickerKey[];
  keyLayer: "online" | "offline" | "unknown";
  subscriptionModels?: readonly SubscriptionModel[];
  // Off while the main model uses the ChatGPT plan.
  inactive?: boolean;
  manualPrice?: { input: string; output: string };
  onChange(value: RoleChoice | undefined): void;
  onKeys(role: ModelRole, provider: string, trigger: HTMLButtonElement): void;
  onPrice?(value: { input: string; output: string }): void;
}

export function RoleCard({
  modelRole: role,
  value,
  providers,
  keys,
  keyLayer,
  subscriptionModels = [],
  inactive,
  manualPrice,
  onChange,
  onKeys,
  onPrice,
}: RoleCardProps) {
  const titleId = useId();
  const { title, description } = ROLE[role];
  const provider = value && providerById(value.provider);
  const tier = providers
    .find((row) => row.id === value?.provider)
    ?.models.find((model) => model.id === value?.model)?.tier;
  const on = role === "main" || !!value;
  return (
    <section className="settings-card" aria-labelledby={titleId} data-role={role}>
      {role === "main" ? (
        <header className="settings-card-head">
          <div>
            <h4 id={titleId} className="settings-card-title">
              {title}
            </h4>
            <p className="settings-card-note">{description}</p>
          </div>
          {tier && <Badge>{TIER[tier]}</Badge>}
        </header>
      ) : (
        <Switch
          className="settings-card-switch"
          label={
            <span id={titleId} className="settings-card-title">
              {title}
            </span>
          }
          description={description}
          checked={!!value && !inactive}
          disabledReason={inactive ? "Off while the main model uses the ChatGPT plan." : undefined}
          onCheckedChange={(checked) => onChange(checked ? { provider: "", model: "" } : undefined)}
        />
      )}
      <Collapse open={on && !inactive}>
        {value || role === "main" ? (
          <div className="settings-card-body">
            <ModelChooser
              modelRole={role}
              value={value ?? { provider: "", model: "" }}
              providers={providers}
              subscriptionModels={subscriptionModels}
              onChange={onChange}
            />
            {value && provider && !provider.notOffered && (
              <RoleDetails
                modelRole={role}
                value={value}
                keys={keys}
                keyLayer={keyLayer}
                manualPrice={manualPrice}
                onChange={onChange}
                onKeys={onKeys}
                onPrice={onPrice}
              />
            )}
          </div>
        ) : null}
      </Collapse>
    </section>
  );
}

function RoleDetails({
  modelRole: role,
  value,
  keys,
  keyLayer,
  manualPrice,
  onChange,
  onKeys,
  onPrice,
}: Pick<
  RoleCardProps,
  "modelRole" | "keys" | "keyLayer" | "manualPrice" | "onChange" | "onKeys" | "onPrice"
> & { value: RoleChoice }) {
  const provider = providerById(value.provider);
  if (!provider) return null;
  const available = matchingKeys(provider, keys);
  const missing = !!value.key && !available.some((key) => key.id === value.key);
  const keyed = !provider.local && !provider.availableIn;
  const keyReason =
    keyLayer !== "online"
      ? "Keys can't be read right now. Reconnect, then choose one."
      : !available.length && !missing
        ? `No keys for ${provider.name} yet. Add one.`
        : undefined;
  const keyNote = provider.plan
    ? "Use a key from this plan, not a pay-as-you-go key."
    : provider.client === "azure" || provider.custom
      ? "The endpoint's address is set with the key."
      : undefined;
  return (
    <>
      {keyed && (
        <div className="settings-key-row">
          <Field label="Key" description={keyNote} disabledReason={keyReason}>
            <Select
              value={value.key ?? ""}
              placeholder="Choose a key"
              items={[
                ...(missing && value.key
                  ? [
                      {
                        value: value.key,
                        label: value.key,
                        disabledReason: "Missing, or bound to another provider",
                      },
                    ]
                  : []),
                ...available.map((key) => ({
                  value: key.id,
                  label: key.id,
                  description: key.baseURL,
                })),
              ]}
              onValueChange={(key) => onChange({ ...value, key: key || undefined })}
            />
          </Field>
          <Button
            className="settings-add-key"
            icon="key-round"
            disabledReason={keyLayer !== "online" ? "Keys can't be read right now" : undefined}
            onClick={(event) => onKeys(role, provider.id, event.currentTarget)}
          >
            Add key
          </Button>
        </div>
      )}
      {provider.custom && <CustomEndpoint value={value} onChange={onChange} />}
      {manualPrice && value.provider !== CHATGPT && (
        <ManualPrice value={manualPrice} onPrice={onPrice} />
      )}
    </>
  );
}

function CustomEndpoint({
  value,
  onChange,
}: {
  value: RoleChoice;
  onChange(value: RoleChoice): void;
}) {
  return (
    <>
      <Switch
        label="Can see images"
        description="Needed to work the screen."
        checked={value.vision !== false}
        onCheckedChange={(checked) => onChange({ ...value, vision: checked ? undefined : false })}
      />
      <Field label="Context window" description="Optional. Leave empty for 32,768.">
        <TextField
          inputMode="numeric"
          maxLength={9}
          placeholder="32768"
          autoComplete="off"
          suffix="tokens"
          value={value.contextTokens ?? ""}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, "");
            onChange({ ...value, contextTokens: digits ? Number(digits) : undefined });
          }}
        />
      </Field>
      <Switch
        label="Flat-rate plan"
        description={
          value.plan ? "Uses the plan's limits, not a spending limit." : "No per-token price."
        }
        checked={value.plan === true}
        onCheckedChange={(checked) =>
          onChange({ ...value, plan: checked ? true : undefined, price: undefined })
        }
      />
    </>
  );
}

function ManualPrice({
  value,
  onPrice,
}: {
  value: { input: string; output: string };
  onPrice?(value: { input: string; output: string }): void;
}) {
  const noteId = useId();
  const field = (side: "input" | "output", label: string) => (
    <Field label={label}>
      <TextField
        inputMode="decimal"
        maxLength={64}
        autoComplete="off"
        prefix="$"
        aria-describedby={noteId}
        value={value[side]}
        onChange={(event) => onPrice?.({ ...value, [side]: event.target.value })}
      />
    </Field>
  );
  return (
    <div className="settings-price">
      <div className="settings-price-fields">
        {field("input", "Input price")}
        {field("output", "Output price")}
      </div>
      <p id={noteId} className="settings-note">
        US dollars per million tokens, from 0 to 10,000; one may be 0. Used to set aside a task's
        spending. It isn't your bill.
      </p>
    </div>
  );
}
