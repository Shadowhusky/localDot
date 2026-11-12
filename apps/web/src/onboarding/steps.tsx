import {
  BALANCED_AUTONOMY,
  CAREFUL_AUTONOMY,
  type ComputerSize,
  type ComputerSizeView,
} from "@localdot/protocol";
import { providerById } from "@localdot/providers";
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import type { BrowserEngineName } from "../../../../packages/protocol/src/browser-engine.ts";
import type {
  SpeechInstallStatus,
  SpeechTierId,
} from "../../../../packages/protocol/src/speech-install.ts";
import { AUTONOMY_PRESETS } from "../copy/autonomy.ts";
import { rich, t, tc } from "../i18n/index.ts";
import { DOCTOR } from "../keys/Protection.tsx";
import { ChromeTerms } from "../settings/BrowserEngineSettings.tsx";
import { SizeSlider, tooSmall } from "../settings/ComputerSize.tsx";
import { modelAllowed, type PickerModel, type SubscriptionModel } from "../settings/choices.ts";
import { modelItems } from "../settings/chooser.ts";
import { cpuCount, gigabytes, sameSize } from "../settings/computer-size.ts";
import { SpeechProgress, SpeechTierPicker } from "../settings/SpeechInstall.tsx";
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
import type { SpeechInstallControl } from "../voice/useSpeechInstall.ts";
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
          label={t`My own computer`}
          detail={t`It runs in its own space, apart from your files`}
        />
        <GroupRow
          leading={<IconTile icon="hand" />}
          label={t`You stay in charge`}
          detail={t`Take over, pause or stop whenever you like`}
        />
        <GroupRow
          leading={<IconTile icon="lock" />}
          label={t`Your keys stay here`}
          detail={t`They never leave the computer running localDot`}
        />
      </Group>
      <p className="onboarding-note">{t`Setup takes about two minutes.`}</p>
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
      aria-label={t`How dot thinks`}
      mark="end"
      roomy
      value={value}
      onValueChange={(kind) => onChange(kind as ThinkKind)}
      options={[
        {
          value: "api",
          label: t`API key`,
          icon: "key-round",
          description: t`Pay for what dot uses through your API provider.`,
        },
        {
          value: "chatgpt",
          label: t`ChatGPT plan`,
          icon: "message-circle",
          description: t`Use your ChatGPT subscription.`,
          disabledReason: chatgptReason,
        },
        {
          value: "claude-code",
          label: "Claude Code",
          icon: "terminal",
          description: t`Use Claude Code installed on the computer running localDot.`,
          disabledReason: claudeReason,
        },
        {
          value: "plan",
          label: t`Coding plan`,
          icon: "code",
          description: t`A monthly plan from MiniMax, Qwen and others.`,
        },
        {
          value: "local",
          label: t`Local model`,
          icon: "cpu",
          description: t`Run a model on your computer with LM Studio or Ollama.`,
        },
        {
          value: "custom",
          label: t`Custom address`,
          icon: "globe",
          description: t`Any OpenAI- or Anthropic-compatible server.`,
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
          placeholder={saved ? t`Paste a new key to replace it` : t`Paste your key`}
          readOnly={busy}
          enterKeyHint="done"
          suffix={
            busy ? (
              <Spinner size={14} />
            ) : saved ? (
              <span className="onboarding-saved">
                <Icon name="check-circle" size={16} />
                {t`Saved`}
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
      ? count === 1
        ? computer.length
          ? t`${count} model available, including ones that can use a computer.`
          : t`${count} model available.`
        : computer.length
          ? t`${count} models available, including ones that can use a computer.`
          : t`${count} models available.`
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
          <Field label={tc("subscription", "Plan")} inline className="ui-group-row">
            <Select
              appearance="inline"
              value={provider}
              items={PLAN_PROVIDERS.map((p) => ({
                value: p.id,
                label: p.name,
                disabledReason: p.notOffered
                  ? t`Its maker allows it only in their own tools`
                  : undefined,
              }))}
              onValueChange={onProvider}
            />
          </Field>
        </Group>
      )}
      <SecretField
        {...secret}
        label={t`${name} key`}
        hint={help ?? (spec?.rule && kind === "plan" ? spec.rule : undefined)}
      />
      {page && (
        <p className="onboarding-link">
          {rich`Need a key? ${(
            <a href={page} target="_blank" rel="noopener noreferrer">
              {t`Get one from ${name}`}
            </a>
          )}`}
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
        {chosen?.name ?? t`More…`}
      </Chip>
      <Menu open={open} onClose={() => setOpen(false)} anchor={chip} label={t`More providers`}>
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
      aria-label={t`App on this Mac`}
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
            ? t`Start its local server, then load a model.`
            : t`Keep Ollama running with a model pulled.`,
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
          aria-label={t`Kind of server`}
          size={32}
          value={flavor}
          onValueChange={onFlavor}
          items={CUSTOM_PROVIDERS.map((p) => ({
            value: p.id,
            label:
              p.client === "anthropic-compatible" ? t`Anthropic-compatible` : t`OpenAI-compatible`,
          }))}
        />
      </div>
      <Field
        label={t`Address`}
        description={
          flavor === "anthropic-compatible"
            ? t`Use https, ending in /v1. Apps on this Mac go through Local model.`
            : t`Use https. Apps on this Mac go through Local model.`
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
      <SecretField {...secret} label={t`Key`} />
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
          suffix={t`per million`}
          value={value[side]}
          onChange={(event) => change({ ...value, [side]: event.currentTarget.value })}
        />
      </Field>
    ));
  if (kind === "local" || kind === "custom")
    return (
      <>
        <Field
          label={t`Model`}
          description={
            kind === "local"
              ? spec
                ? t`As ${spec.name} names it, such as qwen3.`
                : t`As the app names it, such as qwen3.`
              : t`As your server names it.`
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
            label={t`Fast model`}
            description={t`Optional. A quicker model on the same server, for summaries and purpose checks.`}
          >
            <TextField
              {...PLAIN}
              size="lg"
              maxLength={128}
              placeholder={t`Leave empty for none`}
              value={fastModel}
              onChange={(event) => onFastModel(event.currentTarget.value)}
            />
          </Field>
        )}
        {kind === "custom" && (
          <Group roomy>
            <Switch
              className="ui-group-row"
              label={t`Flat-rate plan`}
              description={plan ? t`Uses the plan's own limits.` : t`Priced per token instead.`}
              checked={plan}
              onCheckedChange={onPlan}
            />
            {!plan && prices(price, onPrice, t`Input price`, t`Output price`)}
            {!plan &&
              fastModel.trim() &&
              prices(fastPrice, onFastPrice, t`Fast model input`, t`Fast model output`)}
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
            <span role="status">{loading ? t`Loading models…` : t`Model list unavailable`}</span>
          }
          detail={
            loading
              ? t`Downloading the available models.`
              : appKind(kind)
                ? t`The model list hasn't loaded. Go back and try again in a moment.`
                : catalogAvailable
                  ? t`No compatible models are listed for this provider. Refresh the list or choose another provider.`
                  : t`The model list couldn't be downloaded. Check your connection and retry. Your saved key is kept.`
          }
          trailing={
            onRefresh ? (
              <Button size="sm" busy={loading} onClick={onRefresh}>
                {t`Retry`}
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
              ? t`Checking for new models…`
              : catalogStatus.stale
                ? t`Using a saved list. The latest list couldn’t be reached.`
                : t`Models checked automatically.`}
          </span>
          {onRefresh && (
            <Button size="sm" busy={catalogStatus.refreshing} onClick={onRefresh}>
              {catalogStatus.refreshFailed ? t`Retry` : t`Refresh`}
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
              {main === recommended && <Badge>{t`Recommended`}</Badge>}
            </>
          }
          detail={capability ? abilityLine(capability) : undefined}
          trailing={
            <Select
              appearance="inline"
              aria-label={t`Main model`}
              shown={t`Change`}
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
            label={t`Use a faster model for small jobs`}
            description={t`Summaries of long tasks and purpose checks, for less`}
            checked={fast}
            onCheckedChange={onFast}
          />
          {fast && (
            <Field label={t`Fast model`} inline className="ui-group-row">
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
  // By policy rather than by name, which is in the language on show.
  const looks = new Map<unknown, { icon: IconName; line: string }>([
    [
      BALANCED_AUTONOMY,
      {
        icon: "sliders-horizontal",
        line: t`Asks before sending, buying, deleting or sharing your files.`,
      },
    ],
    [CAREFUL_AUTONOMY, { icon: "shield", line: t`Also asks before each step on its computer.` }],
  ]);
  return (
    <RadioCards
      className="onboarding-choices"
      aria-label={t`How often dot checks with you`}
      mark="end"
      roomy
      value={value}
      onValueChange={onChange}
      options={AUTONOMY_PRESETS.map((preset) => ({
        value: preset.label,
        label: preset.label,
        tag: preset.recommended ? t`Recommended` : undefined,
        icon: looks.get(preset.policy)?.icon,
        description: looks.get(preset.policy)?.line ?? preset.summary,
      }))}
    />
  );
}

// Chrome is the suggestion and needs the user's own accept, which the step's button makes.
export function BrowserStep({
  value,
  onChange,
}: {
  value: BrowserEngineName;
  onChange(engine: BrowserEngineName): void;
}) {
  return (
    <>
      <RadioCards
        className="onboarding-choices"
        aria-label={t`Which web browser dot uses`}
        mark="end"
        roomy
        value={value}
        onValueChange={(next) => onChange(next as BrowserEngineName)}
        options={[
          {
            value: "chrome",
            label: "Google Chrome",
            tag: t`Recommended`,
            icon: "globe",
            description: t`The browser most sites are built for. It also plays protected video.`,
          },
          {
            value: "chromium",
            label: "Chromium",
            icon: "shield",
            description: t`Comes with localDot, with nothing more to install or accept.`,
          },
        ]}
      />
      {value === "chrome" && (
        <p className="onboarding-note">
          <ChromeTerms />
        </p>
      )}
    </>
  );
}

// Optional, and nothing downloads until the step's button is pressed. The computer running localDot
// does the download in the background, whichever device this is.
export function SpeechStep({
  speech,
  status,
  tier,
  onTier,
  language,
  phone,
}: {
  speech: SpeechInstallControl;
  status: SpeechInstallStatus;
  tier: SpeechTierId;
  onTier(tier: SpeechTierId): void;
  language: string;
  phone: boolean;
}) {
  const { job, installed, handInstalled, host } = status;
  const computer = host.computer;
  if (job)
    return (
      <Group roomy>
        <GroupRow
          leading={<IconTile icon="download" />}
          label={
            <span role="status">
              {job.state !== "running"
                ? t`The download stopped`
                : computer === "Mac"
                  ? t`Downloading on your Mac`
                  : t`Downloading on your computer`}
            </span>
          }
          detail={
            job.state === "running" ? t`Setup doesn't need to wait for it. Keep going.` : undefined
          }
        >
          <SpeechProgress job={job}>
            {job.state === "failed" && (
              <Button
                size="sm"
                busy={speech.pending === "install"}
                onClick={() => void speech.install(job.tier)}
              >
                {t`Retry`}
              </Button>
            )}
            <Button size="sm" variant="quiet" onClick={speech.cancel}>
              {job.state === "failed" ? t`Discard` : t`Cancel`}
            </Button>
          </SpeechProgress>
        </GroupRow>
      </Group>
    );
  if (installed || handInstalled)
    return (
      <Group roomy>
        <GroupRow
          leading={<IconTile icon="mic" />}
          label={installed?.name ?? t`Your own Whisper`}
          detail={
            !installed
              ? t`You set this up, so there's nothing to install.`
              : computer === "Mac"
                ? t`Installed on your Mac. Change it any time in Settings.`
                : t`Installed on your computer. Change it any time in Settings.`
          }
        />
      </Group>
    );
  return (
    <>
      <SpeechTierPicker status={status} language={language} value={tier} onChange={onTier} roomy />
      <p className="onboarding-note">
        {!phone
          ? t`It downloads in the background, so setup won't wait. You can change this in Settings.`
          : computer === "Mac"
            ? t`Your Mac does the download, not this phone. It carries on in the background, and you can change this in Settings.`
            : t`Your computer does the download, not this phone. It carries on in the background, and you can change this in Settings.`}
      </p>
    </>
  );
}

export interface SummaryRow {
  icon: IconName;
  label: string;
  value: string;
  change(): void;
}

export function SummaryStep({
  rows,
  children,
}: {
  rows: readonly SummaryRow[];
  children?: ReactNode;
}) {
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
                  aria-label={t`Change ${row.label.toLowerCase()}`}
                  onClick={row.change}
                >
                  {t`Change`}
                </Button>
              </>
            }
          />
        ))}
        {children}
      </Group>
      <p className="onboarding-note">
        {t`Everything here is in Settings later. There's no spending limit unless you set one.`}
      </p>
    </>
  );
}

export interface SizeChoice {
  view: ComputerSizeView;
  size: ComputerSize;
  recommended: ComputerSize | null;
  onChange(size: ComputerSize): void;
}

// The computer's size before it is first turned on: the recommended one, or changed in place.
export function SizeRow({ choice }: { choice: SizeChoice }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { view, size, recommended } = choice;
  const problem = tooSmall(view);
  if (problem)
    return (
      <GroupRow leading={<IconTile icon="monitor" />} label={t`Computer size`}>
        <p className="onboarding-size-problem" role="alert">
          {problem}
        </p>
      </GroupRow>
    );
  return (
    <GroupRow
      leading={<IconTile icon="monitor" />}
      label={t`Computer size`}
      detail={recommended && sameSize(size, recommended) ? t`Recommended` : t`Your choice`}
      trailing={
        <>
          <span className="onboarding-summary-value">
            {`${gigabytes(size.memoryBytes)} · ${cpuCount(size.cpus)}`}
          </span>
          <Button
            variant="quiet"
            size="sm"
            aria-label={t`Change computer size`}
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((now) => !now)}
          >
            {open ? t`Done` : t`Change`}
          </Button>
        </>
      }
    >
      {open && (
        <div id={id} className="onboarding-size">
          <SizeSlider kind="memory" view={view} size={size} onChange={choice.onChange} />
          <SizeSlider kind="cpus" view={view} size={size} onChange={choice.onChange} />
        </div>
      )}
    </GroupRow>
  );
}
