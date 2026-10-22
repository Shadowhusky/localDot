import { providerById } from "@localdot/providers";
import { type RefObject, useRef, useState } from "react";
import { AUTONOMY_PRESETS } from "../copy/autonomy.ts";
import { DOCTOR } from "../keys/Protection.tsx";
import { modelAllowed, type PickerModel, type SubscriptionModel } from "../settings/choices.ts";
import { modelItems } from "../settings/chooser.ts";
import { CommandChip } from "../shell/CommandChip.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupNote, GroupRow, IconTile } from "../ui/Group.tsx";
import { Icon } from "../ui/Icon.tsx";
import type { IconName } from "../ui/icons.ts";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import { RadioCards } from "../ui/RadioCards.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Select } from "../ui/Select.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import {
  API_PROVIDERS,
  abilityLine,
  appKind,
  CUSTOM_PROVIDERS,
  FEATURED_API,
  hostOf,
  KEY_PAGES,
  LOCAL_PROVIDERS,
  PLAN_PROVIDERS,
  type ThinkKind,
} from "./wizard.ts";

// Keys go as pasted: no capitals, corrections, spelling marks or saved passwords.
const PLAIN = {
  autoComplete: "off",
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
  "data-1p-ignore": "true",
  "data-lpignore": "true",
} as const;

export function WelcomeStep() {
  return (
    <>
      <Group roomy>
        <GroupRow
          leading={<IconTile icon="monitor" />}
          label="My own computer"
          detail="It runs in its own space, apart from your files"
        />
        <GroupRow
          leading={<IconTile icon="hand" />}
          label="You stay in charge"
          detail="Take over, pause or stop whenever you like"
        />
        <GroupRow
          leading={<IconTile icon="lock" />}
          label="Your keys stay here"
          detail="They never leave the computer running localDot"
        />
      </Group>
      <p className="onboarding-note">Setup takes about two minutes.</p>
    </>
  );
}

export function ThinksStep({
  value,
  chatgptReason,
  claudeReason,
  onChange,
}: {
  value: ThinkKind;
  chatgptReason?: string;
  claudeReason?: string;
  onChange(kind: ThinkKind): void;
}) {
  return (
    <RadioCards
      className="onboarding-choices"
      aria-label="How dot thinks"
      mark="end"
      roomy
      value={value}
      onValueChange={(kind) => onChange(kind as ThinkKind)}
      options={[
        {
          value: "api",
          label: "API key",
          icon: "key-round",
          description: "Pay for what dot uses through your API provider.",
        },
        {
          value: "chatgpt",
          label: "ChatGPT plan",
          icon: "message-circle",
          description: "Use your ChatGPT subscription.",
          disabledReason: chatgptReason,
        },
        {
          value: "claude-code",
          label: "Claude Code",
          icon: "terminal",
          description: "Use Claude Code installed on the computer running localDot.",
          disabledReason: claudeReason,
        },
        {
          value: "plan",
          label: "Coding plan",
          icon: "code",
          description: "A monthly plan from MiniMax, Qwen and others.",
        },
        {
          value: "local",
          label: "Local model",
          icon: "cpu",
          description: "Run a model on your computer with LM Studio or Ollama.",
        },
        {
          value: "custom",
          label: "Custom address",
          icon: "globe",
          description: "Any OpenAI- or Anthropic-compatible server.",
        },
      ]}
    />
  );
}

interface SecretProps {
  secret: RefObject<HTMLInputElement | null>;
  // The stored key dot will use, once there is one.
  saved: string | null;
  unavailable?: string;
  onTyped(typed: boolean): void;
  onPaste?(): void;
  busy?: boolean;
}

function SecretField({
  label,
  hint,
  secret,
  saved,
  unavailable,
  onTyped,
  onPaste,
  busy,
}: SecretProps & { label: string; hint?: string }) {
  return (
    <>
      <Field
        label={label}
        description={hint}
        disabledReason={unavailable}
        className="onboarding-secret"
      >
        {/* Drawn as dots, as a text field: Chrome offers to save a password field's value. */}
        <TextField
          ref={secret}
          {...PLAIN}
          size="lg"
          className="onboarding-secret-field"
          placeholder={saved ? "Paste a new key to replace it" : "Paste your key"}
          readOnly={busy}
          enterKeyHint="done"
          suffix={
            busy ? (
              <Spinner size={14} />
            ) : saved ? (
              <span className="onboarding-saved">
                <Icon name="check-circle" size={16} />
                Saved
              </span>
            ) : undefined
          }
          onChange={(event) => onTyped(event.currentTarget.value.trim().length > 0)}
          onPaste={onPaste}
        />
      </Field>
      {unavailable && <CommandChip text={DOCTOR} className="onboarding-fix" />}
    </>
  );
}

export function KeyStep({
  kind,
  provider,
  onProvider,
  models,
  ...secret
}: SecretProps & {
  kind: "api" | "plan";
  provider: string;
  onProvider(provider: string): void;
  models: readonly PickerModel[];
}) {
  const spec = providerById(provider);
  const name = spec?.name ?? provider;
  const page = KEY_PAGES[provider];
  const computer = models.filter(
    (model) => model.tier === "native" || model.tier === "vision-tools",
  );
  const count = models.filter((model) => modelAllowed("main", model)).length;
  const help =
    secret.saved && count
      ? `${count} ${count === 1 ? "model" : "models"} available${computer.length ? ", including ones that can use a computer" : ""}.`
      : undefined;
  return (
    <>
      {kind === "api" ? (
        <div className="onboarding-chips">
          {FEATURED_API.map((id) => (
            <Chip
              key={id}
              variant="outline"
              aria-pressed={provider === id}
              onClick={() => onProvider(id)}
            >
              {id === "google" ? "Google" : (providerById(id)?.name ?? id)}
            </Chip>
          ))}
          <MoreProviders provider={provider} onProvider={onProvider} />
        </div>
      ) : (
        <Group roomy>
          <Field label="Plan" inline className="ui-group-row">
            <Select
              appearance="inline"
              value={provider}
              items={PLAN_PROVIDERS.map((p) => ({
                value: p.id,
                label: p.name,
                disabledReason: p.notOffered
                  ? "Its maker allows it only in their own tools"
                  : undefined,
              }))}
              onValueChange={onProvider}
            />
          </Field>
        </Group>
      )}
      <SecretField
        {...secret}
        label={`${name} key`}
        hint={help ?? (spec?.rule && kind === "plan" ? spec.rule : undefined)}
      />
      {page && (
        <p className="onboarding-link">
          Need a key?{" "}
          <a href={page} target="_blank" rel="noopener noreferrer">
            Get one from {name}
          </a>
          <span className="onboarding-host">{hostOf(page)}</span>
        </p>
      )}
    </>
  );
}

// The rest of the pay-as-you-go providers, from a chip after the three most people use.
function MoreProviders({
  provider,
  onProvider,
}: {
  provider: string;
  onProvider(provider: string): void;
}) {
  const chip = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const more = API_PROVIDERS.filter(
    (p) => !FEATURED_API.includes(p.id as (typeof FEATURED_API)[number]),
  );
  const chosen = more.find((p) => p.id === provider);
  return (
    <>
      <Chip
        ref={chip}
        variant="outline"
        aria-pressed={!!chosen}
        {...triggerProps("menu", open)}
        onClick={() => setOpen(true)}
      >
        {chosen?.name ?? "More…"}
      </Chip>
      <Menu open={open} onClose={() => setOpen(false)} anchor={chip} label="More providers">
        {more.map((p) => (
          <MenuItem key={p.id} onSelect={() => onProvider(p.id)}>
            {p.name}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

export function LocalStep({ value, onChange }: { value: string; onChange(id: string): void }) {
  return (
    <RadioCards
      className="onboarding-choices"
      aria-label="App on this Mac"
      mark="end"
      roomy
      value={value}
      onValueChange={onChange}
      options={LOCAL_PROVIDERS.map((p) => ({
        value: p.id,
        label: p.name,
        icon: "cpu" as const,
        description:
          p.id === "lmstudio"
            ? "Start its local server, then load a model."
            : "Keep Ollama running with a model pulled.",
      }))}
    />
  );
}

export function CustomKeyStep({
  flavor,
  address,
  onFlavor,
  onAddress,
  ...secret
}: SecretProps & {
  flavor: string;
  address: string;
  onFlavor(id: string): void;
  onAddress(address: string): void;
}) {
  return (
    <>
      <div className="onboarding-center">
        <SegmentedControl
          aria-label="Kind of server"
          size={32}
          value={flavor}
          onValueChange={onFlavor}
          items={CUSTOM_PROVIDERS.map((p) => ({
            value: p.id,
            label:
              p.client === "anthropic-compatible" ? "Anthropic-compatible" : "OpenAI-compatible",
          }))}
        />
      </div>
      <Field
        label="Address"
        description={
          flavor === "anthropic-compatible"
            ? "Use https, ending in /v1. Apps on this Mac go through Local model."
            : "Use https. Apps on this Mac go through Local model."
        }
        className="onboarding-address"
      >
        <TextField
          {...PLAIN}
          size="lg"
          inputMode="url"
          placeholder="https://api.example.com/v1"
          value={address}
          onChange={(event) => onAddress(event.currentTarget.value)}
        />
      </Field>
      <SecretField {...secret} label="Key" />
    </>
  );
}

export function ModelStep({
  loading = false,
  onRefresh,
  catalogAvailable = false,
  catalogStatus,
  kind,
  provider,
  models,
  allModels,
  subscriptionModels,
  main,
  recommended,
  typedModel,
  fast,
  fastAvailable,
  fastModel,
  plan,
  price,
  fastPrice,
  onMain,
  onFast,
  onFastModel,
  onPlan,
  onPrice,
  onFastPrice,
}: {
  loading?: boolean;
  onRefresh?(): void;
  catalogAvailable?: boolean;
  catalogStatus?: { stale?: boolean; refreshing?: boolean; refreshFailed?: boolean } | null;
  kind: ThinkKind;
  provider: string;
  models: readonly PickerModel[];
  allModels: readonly PickerModel[];
  subscriptionModels: readonly SubscriptionModel[];
  main: string;
  recommended?: string;
  typedModel: string;
  fast: boolean;
  fastAvailable: boolean;
  fastModel: string;
  plan: boolean;
  price: { input: string; output: string };
  fastPrice: { input: string; output: string };
  onMain(model: string): void;
  onFast(on: boolean): void;
  onFastModel(model: string): void;
  onPlan(on: boolean): void;
  onPrice(price: { input: string; output: string }): void;
  onFastPrice(price: { input: string; output: string }): void;
}) {
  const spec = providerById(provider);
  const prices = (
    value: { input: string; output: string },
    change: (price: { input: string; output: string }) => void,
    input: string,
    output: string,
  ) =>
    (
      [
        ["input", input],
        ["output", output],
      ] as const
    ).map(([side, label]) => (
      <Field key={side} label={label} inline className="ui-group-row">
        <TextField
          size="sm"
          inputMode="decimal"
          maxLength={64}
          autoComplete="off"
          prefix="$"
          suffix="per million"
          value={value[side]}
          onChange={(event) => change({ ...value, [side]: event.currentTarget.value })}
        />
      </Field>
    ));
  if (kind === "local" || kind === "custom")
    return (
      <>
        <Field
          label="Model"
          description={
            kind === "local"
              ? `As ${spec?.name ?? "the app"} names it, such as qwen3.`
              : "As your server names it."
          }
        >
          <TextField
            {...PLAIN}
            size="lg"
            maxLength={128}
            placeholder={kind === "local" ? "qwen3" : "model-name"}
            value={typedModel}
            onChange={(event) => onMain(event.currentTarget.value)}
          />
        </Field>
        {kind === "custom" && (
          <Field
            label="Fast model"
            description="Optional. A quicker model on the same server, for summaries and purpose checks."
          >
            <TextField
              {...PLAIN}
              size="lg"
              maxLength={128}
              placeholder="Leave empty for none"
              value={fastModel}
              onChange={(event) => onFastModel(event.currentTarget.value)}
            />
          </Field>
        )}
        {kind === "custom" && (
          <Group roomy>
            <Switch
              className="ui-group-row"
              label="Flat-rate plan"
              description={plan ? "Uses the plan's own limits." : "Priced per token instead."}
              checked={plan}
              onCheckedChange={onPlan}
            />
            {!plan && prices(price, onPrice, "Input price", "Output price")}
            {!plan &&
              fastModel.trim() &&
              prices(fastPrice, onFastPrice, "Fast model input", "Fast model output")}
          </Group>
        )}
      </>
    );
  const items = appKind(kind)
    ? modelItems("main", undefined, kind, [], subscriptionModels, main)
    : modelItems("main", spec, provider, models, [], main);
  const chosen = appKind(kind)
    ? subscriptionModels.find((model) => model.id === main)
    : models.find((model) => model.id === main);
  const capability = appKind(kind) ? undefined : models.find((model) => model.id === main);
  if (!items.length)
    return (
      <Group roomy>
        <GroupRow
          label={
            <span role="status">{loading ? "Loading models…" : "Model list unavailable"}</span>
          }
          detail={
            loading
              ? "Downloading the available models."
              : appKind(kind)
                ? "The model list hasn't loaded. Go back and try again in a moment."
                : catalogAvailable
                  ? "No compatible models are listed for this provider. Refresh the list or choose another provider."
                  : "The model list couldn't be downloaded. Check your connection and retry. Your saved key is kept."
          }
          trailing={
            onRefresh ? (
              <Button size="sm" busy={loading} onClick={onRefresh}>
                Retry
              </Button>
            ) : undefined
          }
        />
      </Group>
    );
  return (
    <>
      {catalogStatus && (
        <GroupNote className="onboarding-catalog-status" role="status">
          <span>
            {catalogStatus.refreshing
              ? "Checking for new models…"
              : catalogStatus.stale
                ? "Using a saved list. The latest list couldn’t be reached."
                : "Models checked automatically."}
          </span>
          {onRefresh && (
            <Button size="sm" busy={catalogStatus.refreshing} onClick={onRefresh}>
              {catalogStatus.refreshFailed ? "Retry" : "Refresh"}
            </Button>
          )}
        </GroupNote>
      )}
      <Group roomy>
        <GroupRow
          className="onboarding-model"
          label={
            <>
              {chosen?.name ?? main}
              {main === recommended && <Badge>Recommended</Badge>}
            </>
          }
          detail={capability ? abilityLine(capability) : undefined}
          trailing={
            <Select
              appearance="inline"
              aria-label="Main model"
              shown="Change"
              value={main}
              items={items}
              onValueChange={onMain}
            />
          }
        />
      </Group>
      {fastAvailable && !appKind(kind) && (
        <Group roomy>
          <Switch
            className="ui-group-row onboarding-fast"
            label="Use a faster model for small jobs"
            description="Summaries of long tasks and purpose checks, for less"
            checked={fast}
            onCheckedChange={onFast}
          />
          {fast && (
            <Field label="Fast model" inline className="ui-group-row">
              <Select
                appearance="inline"
                value={fastModel}
                items={modelItems("fast", spec, provider, allModels, [], fastModel).filter(
                  (item) => item.value !== main,
                )}
                onValueChange={onFastModel}
              />
            </Field>
          )}
        </Group>
      )}
    </>
  );
}

export function PermissionsStep({
  value,
  onChange,
}: {
  value: string;
  onChange(preset: string): void;
}) {
  const icons: Record<string, IconName> = { Balanced: "sliders-horizontal", Careful: "shield" };
  const lines: Record<string, string> = {
    Balanced: "Asks before sending, buying, deleting or sharing your files.",
    Careful: "Also asks before each step on its computer.",
  };
  return (
    <RadioCards
      className="onboarding-choices"
      aria-label="How often dot checks with you"
      mark="end"
      roomy
      value={value}
      onValueChange={onChange}
      options={AUTONOMY_PRESETS.map((preset) => ({
        value: preset.label,
        label: preset.label,
        tag: preset.recommended ? "Recommended" : undefined,
        icon: icons[preset.label],
        description: lines[preset.label] ?? preset.summary,
      }))}
    />
  );
}

export interface SummaryRow {
  icon: IconName;
  label: string;
  value: string;
  change(): void;
}

export function SummaryStep({ rows }: { rows: readonly SummaryRow[] }) {
  return (
    <>
      <Group roomy>
        {rows.map((row) => (
          <GroupRow
            key={row.label}
            leading={<IconTile icon={row.icon} />}
            label={row.label}
            trailing={
              <>
                <span className="onboarding-summary-value">{row.value}</span>
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label={`Change ${row.label.toLowerCase()}`}
                  onClick={row.change}
                >
                  Change
                </Button>
              </>
            }
          />
        ))}
      </Group>
      <p className="onboarding-note">
        Everything here is in Settings later. There's no spending limit unless you set one.
      </p>
    </>
  );
}
