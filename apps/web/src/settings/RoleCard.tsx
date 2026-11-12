import { isOpenRouterRouterId, providerById } from "@localdot/providers";
import { useId, useRef } from "react";
import { t, tr } from "../i18n/index.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote, GroupRow } from "../ui/Group.tsx";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import {
  customModelAllowed,
  type ModelRole,
  matchingKeys,
  type PickerKey,
  type ProviderModels,
  type RoleChoice,
  type SubscriptionModel,
} from "./choices.ts";
import { subscription } from "./chooser.ts";
import { ModelChooser, modelNote, providerNote } from "./ModelChooser.tsx";
import { ModelOptionsFields, optionsNote } from "./ModelOptionsFields.tsx";
import { roleProblemField } from "./settings-form.ts";

const ROLE: Record<ModelRole, { title: string; description: string }> = {
  main: { title: tr("Main model"), description: tr("Does the work") },
  fast: {
    title: tr("Fast model"),
    description: tr("Summarizes long tasks and answers purpose checks"),
  },
  local: { title: tr("Local model"), description: tr("Runs on this Mac with LM Studio or Ollama") },
};
// Claude Code keeps its own history, so beside it the fast model only answers purpose checks.
const PLAN_FAST = tr("Answers purpose checks; Claude Code summarizes on its own");

// Models that work the screen, which the main model's heading tags; their note says no more.
const SCREEN_TIERS = new Set(["native", "vision-tools"]);

const TIER: Record<string, string> = {
  native: tr("Computer use"),
  "vision-tools": tr("Computer use"),
  "text-only": tr("Tools"),
  "no-tools": tr("Text only"),
};

// Picked from the Key row's list, it opens the form that adds one instead of choosing a key.
const ADD_KEY = "\u0000add-key";

export interface RoleCardProps {
  modelRole: ModelRole;
  value?: RoleChoice;
  providers: readonly ProviderModels[];
  keys: readonly PickerKey[];
  keyLayer: "online" | "offline" | "unknown";
  subscriptionModels?: readonly SubscriptionModel[];
  // The main model's provider, which decides what a fast model beside it can be.
  main?: string;
  // Why the role is off: the main model runs on a plan's own app, which brings its own models.
  inactive?: string;
  manualPrice?: { input: string; output: string };
  // What stops this role being saved, once saving has been tried.
  problem?: string;
  // Why the model failed dot's last quick request, until it answers one again.
  failure?: string;
  onChange(value: RoleChoice | undefined): void;
  onKeys(role: ModelRole, provider: string, trigger: HTMLButtonElement): void;
  onPrice?(value: { input: string; output: string }): void;
}

const problemField = (problem: string | undefined) => (problem ? roleProblemField(problem) : null);

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

// Notes from the catalog may come without a full stop; joined into one line, each needs one.
const sentence = (text: string) => (/[.!?…。！？]$/.test(text) ? text : `${text}.`);

function keyNote(provider: ReturnType<typeof providerById>): string | undefined {
  if (!provider) return undefined;
  if (provider.plan) return t`Use a key from this plan, not a pay-as-you-go key.`;
  if (provider.client === "azure" || provider.custom)
    return t`The endpoint's address is set with its key.`;
  return undefined;
}

// One model role as a group of rows: the main model always, the others behind a switch.
export function RoleCard({
  modelRole: role,
  value,
  providers,
  keys,
  keyLayer,
  subscriptionModels = [],
  main,
  inactive,
  manualPrice,
  problem,
  failure,
  onChange,
  onKeys,
  onPrice,
}: RoleCardProps) {
  const titleId = useId();
  const notesId = useId();
  const { title } = ROLE[role];
  const description =
    role === "fast" && main === "claude-code" ? PLAN_FAST : ROLE[role].description;
  const provider = value && providerById(value.provider);
  const tier = providers
    .find((row) => row.id === value?.provider)
    ?.models.find((model) => model.id === value?.model)?.tier;
  const discovered = providers
    .find((p) => p.id === value?.provider)
    ?.models.find((m) => m.id === value?.model)?.controls;
  const on = role === "main" || !!value;
  const typed =
    !!provider &&
    customModelAllowed(provider) &&
    !providers.find((row) => row.id === value?.provider)?.models.length;
  const notes =
    on && !inactive && value
      ? [
          failure && t`dot's last quick request to it failed: ${failure}`,
          role === "main" && t`Needs a model that can use a computer.`,
          providerNote(value.provider),
          typed && t`Type the model ID as the server names it.`,
          (!SCREEN_TIERS.has(tier ?? "") || isOpenRouterRouterId(value.provider, value.model)) &&
            modelNote(value, providers),
          value.model && optionsNote(value, false, discovered),
          provider && !provider.notOffered && !provider.local && keyNote(provider),
          manualPrice &&
            !subscription(value.provider) &&
            t`Prices are US dollars per million tokens, from 0 to 10,000; one may be 0. Used to set aside a task's spending. It isn't your bill.`,
        ].filter((note): note is string => Boolean(note))
      : [];
  const rows = (value || role === "main") && (
    <>
      <ModelChooser
        modelRole={role}
        value={value ?? { provider: "", model: "" }}
        providers={providers}
        subscriptionModels={subscriptionModels}
        main={main}
        describedBy={notes.length ? notesId : undefined}
        problem={problemField(problem) === "model" ? problem && capital(problem) : undefined}
        onChange={onChange}
      />
      {value?.model && (
        <ModelOptionsFields
          choice={value}
          discovered={discovered}
          accountModel={
            subscription(value.provider)
              ? subscriptionModels?.find((model) => model.id === value.model)
              : undefined
          }
          onChange={onChange}
          outputLimit={
            providers.find((p) => p.id === value.provider)?.models.find((m) => m.id === value.model)
              ?.maxOutputTokens
          }
        />
      )}
      {value && provider && !provider.notOffered && (
        <RoleDetails
          modelRole={role}
          value={value}
          keys={keys}
          keyLayer={keyLayer}
          manualPrice={manualPrice}
          problem={problem}
          onChange={onChange}
          onKeys={onKeys}
          onPrice={onPrice}
        />
      )}
    </>
  );
  return (
    <section className="settings-role" aria-labelledby={titleId} data-role={role}>
      {role === "main" ? (
        <>
          <GroupHead
            id={titleId}
            title={title}
            aside={
              <>
                {description}
                {tier && <Badge className="settings-tier">{TIER[tier]}</Badge>}
              </>
            }
          />
          <Group>{rows}</Group>
        </>
      ) : (
        <Group>
          <Switch
            className="ui-group-row"
            label={<span id={titleId}>{title}</span>}
            description={inactive ? undefined : description}
            checked={!!value && !inactive}
            disabledReason={inactive}
            onCheckedChange={(checked) =>
              onChange(checked ? { provider: "", model: "" } : undefined)
            }
          />
          <Collapse open={on && !inactive}>{rows}</Collapse>
        </Group>
      )}
      {notes.length > 0 && <GroupNote id={notesId}>{notes.map(sentence).join(" ")}</GroupNote>}
    </section>
  );
}

function RoleDetails({
  modelRole: role,
  value,
  keys,
  keyLayer,
  manualPrice,
  problem,
  onChange,
  onKeys,
  onPrice,
}: Pick<
  RoleCardProps,
  "modelRole" | "keys" | "keyLayer" | "manualPrice" | "problem" | "onChange" | "onKeys" | "onPrice"
> & { value: RoleChoice }) {
  const said = (field: ReturnType<typeof problemField>) =>
    problem && problemField(problem) === field ? { error: capital(problem) } : {};
  const row = useRef<HTMLDivElement>(null);
  const provider = providerById(value.provider);
  if (!provider) return null;
  const available = matchingKeys(provider, keys);
  const missing = !!value.key && !available.some((key) => key.id === value.key);
  const keyed = !provider.local && !provider.availableIn;
  const keyReason =
    keyLayer !== "online"
      ? t`Keys can't be read right now. Reconnect, then choose one.`
      : !available.length && !missing
        ? provider.custom
          ? t`No keys for your endpoint yet. Add one.`
          : t`No keys for ${provider.name} yet. Add one.`
        : undefined;
  const addKey = (trigger: HTMLButtonElement) => onKeys(role, provider.id, trigger);
  return (
    <>
      {keyed && (
        <div ref={row} className="settings-key-row">
          {available.length || missing ? (
            <Field
              label={t`Key`}
              inline
              className="ui-group-row"
              disabledReason={keyReason}
              {...said("key")}
            >
              <Select
                appearance="inline"
                value={value.key ?? ""}
                placeholder={t`Choose a key`}
                items={[
                  ...(missing && value.key
                    ? [
                        {
                          value: value.key,
                          label: value.key,
                          disabledReason: t`Missing, or bound to another provider`,
                        },
                      ]
                    : []),
                  ...available.map((key) => ({
                    value: key.id,
                    label: key.id,
                    description: key.baseURL,
                  })),
                  ...(keyLayer === "online" ? [{ value: ADD_KEY, label: t`Add a key…` }] : []),
                ]}
                onValueChange={(key) => {
                  const trigger = row.current?.querySelector<HTMLButtonElement>("[role=combobox]");
                  if (key === ADD_KEY) {
                    if (trigger) addKey(trigger);
                  } else onChange({ ...value, key: key || undefined });
                }}
              />
            </Field>
          ) : (
            <GroupRow
              label={t`Key`}
              detail={keyReason}
              trailing={
                <Button
                  size="sm"
                  icon="key-round"
                  disabledReason={
                    keyLayer !== "online" ? t`Keys can't be read right now` : undefined
                  }
                  onClick={(event) => addKey(event.currentTarget)}
                >
                  {t`Add key`}
                </Button>
              }
            />
          )}
        </div>
      )}
      {provider.custom && (
        <CustomEndpoint value={value} problem={said("context").error} onChange={onChange} />
      )}
      {manualPrice && !subscription(value.provider) && (
        <ManualPrice value={manualPrice} problem={said("price").error} onPrice={onPrice} />
      )}
    </>
  );
}

function CustomEndpoint({
  value,
  problem,
  onChange,
}: {
  value: RoleChoice;
  problem?: string;
  onChange(value: RoleChoice): void;
}) {
  // OpenAI's service tiers ride only on its own formats.
  const tiers = providerById(value.provider)?.client !== "anthropic-compatible";
  return (
    <>
      <Switch
        className="ui-group-row"
        label={t`Can see images`}
        description={t`Needed to work the screen.`}
        checked={value.vision !== false}
        onCheckedChange={(checked) => onChange({ ...value, vision: checked ? undefined : false })}
      />
      <Field
        label={t`Context window`}
        inline
        className="ui-group-row"
        {...(problem ? { error: problem } : {})}
      >
        <TextField
          size="sm"
          inputMode="numeric"
          maxLength={9}
          placeholder="32768"
          autoComplete="off"
          suffix={t`tokens`}
          value={value.contextTokens ?? ""}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, "");
            onChange({ ...value, contextTokens: digits ? Number(digits) : undefined });
          }}
        />
      </Field>
      {tiers && (
        <Switch
          className="ui-group-row"
          label={t`Supports speed tiers`}
          description={t`Fast and Ultrafast, as OpenAI's service tiers.`}
          checked={value.speedTiers === true}
          onCheckedChange={(checked) => {
            const { speed: _, ...options } = value.options ?? {};
            onChange({
              ...value,
              speedTiers: checked ? true : undefined,
              ...(checked ? {} : { options: Object.keys(options).length ? options : undefined }),
            });
          }}
        />
      )}
      <Switch
        className="ui-group-row"
        label={t`Flat-rate plan`}
        description={
          value.plan ? t`Uses the plan's limits, not a spending limit.` : t`No per-token price.`
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
  problem,
  onPrice,
}: {
  value: { input: string; output: string };
  problem?: string;
  onPrice?(value: { input: string; output: string }): void;
}) {
  // The side left empty says so; with both filled in, the first.
  const wrong = !value.input.trim() || value.output.trim() ? "input" : "output";
  const field = (side: "input" | "output", label: string) => (
    <Field
      label={label}
      inline
      className="ui-group-row"
      {...(problem && side === wrong ? { error: problem } : {})}
    >
      <TextField
        size="sm"
        inputMode="decimal"
        maxLength={64}
        autoComplete="off"
        prefix="$"
        value={value[side]}
        onChange={(event) => onPrice?.({ ...value, [side]: event.target.value })}
      />
    </Field>
  );
  return (
    <>
      {field("input", t`Input price`)}
      {field("output", t`Output price`)}
    </>
  );
}
