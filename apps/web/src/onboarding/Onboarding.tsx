import type { AgentSettingsDocument, AutonomyPolicy } from "@localdot/protocol";
import { providerById } from "@localdot/providers";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AUTONOMY_PRESETS, presetOf } from "../copy/autonomy.ts";
import { PresenceSlot } from "../dot/PresenceSlot.tsx";
import {
  bindingOf,
  EMPTY_DRAFT,
  type Provider,
  suggestedId,
  valueProblem,
} from "../keys/binding.ts";
import { keyHome, problemText } from "../keys/keys-api.ts";
import type { KeysController } from "../keys/useKeys.ts";
import type { ApiClient } from "../lib/api.ts";
import { ChatgptPanel } from "../settings/ChatgptPanel.tsx";
import { ClaudeCodePanel } from "../settings/ClaudeCodePanel.tsx";
import { matchingKeys, type RoleChoice } from "../settings/choices.ts";
import type { ProviderIndex } from "../settings/settings-api.ts";
import { useChatgpt } from "../settings/useChatgpt.ts";
import { useClaudeCode } from "../settings/useClaudeCode.ts";
import { Button } from "../ui/Button.tsx";
import { afterMotion } from "../ui/finished.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { saveSetup } from "./save.ts";
import {
  CustomKeyStep,
  KeyStep,
  LocalStep,
  ModelStep,
  PermissionsStep,
  SummaryStep,
  ThinksStep,
  WelcomeStep,
} from "./steps.tsx";
import type { OnboardingControl } from "./useOnboarding.ts";
import {
  appKind,
  CUSTOM_PROVIDERS,
  kindOf,
  nextStep,
  previousStep,
  recommendedFast,
  recommendedMain,
  stepNumber,
  stepTitle,
  type ThinkKind,
  thinksWith,
  WIZARD_STEPS,
  type WizardProgress,
  type WizardStep,
} from "./wizard.ts";
import "./onboarding.css";

export interface OnboardingProps {
  api: ApiClient;
  control: OnboardingControl;
  phone: boolean;
  keys: KeysController;
  index: ProviderIndex | null;
  saved: AgentSettingsDocument | null;
  modelsLoading?: boolean;
  onRefreshModels?(): void;
  onCheckModels?(): void;
  // The saved settings changed: read them again.
  onSaved(): void;
  // Turns the computer on; null while it is already on.
  turnOn: { run(): void; reason?: string } | null;
  showDot: boolean;
}

export interface SetupDraft {
  kind: ThinkKind;
  provider: string;
  address: string;
  model: string;
  fast: boolean;
  fastModel: string;
  plan: boolean;
  price: { input: string; output: string };
  preset: string;
}

const FIRST_PROVIDER: Record<ThinkKind, string> = {
  api: "anthropic",
  chatgpt: "chatgpt",
  "claude-code": "claude-code",
  plan: "minimax-coding-plan",
  local: "lmstudio",
  custom: "openai-compatible",
};

function draftOf(progress: WizardProgress, saved: AgentSettingsDocument | null): SetupDraft {
  const main = saved?.main;
  const kind = progress.kind ?? kindOf(main?.provider) ?? "api";
  const provider =
    progress.provider ??
    (main && kindOf(main.provider) === kind ? main.provider : FIRST_PROVIDER[kind]);
  return {
    kind,
    provider,
    address: "",
    model: main?.provider === provider ? main.model : "",
    fast: !saved?.main || saved.fast !== undefined,
    fastModel: saved?.fast?.provider === provider ? saved.fast.model : "",
    plan: main?.plan === true,
    price: {
      input: main?.price ? String(main.price.inputUSDPerMTok) : "",
      output: main?.price ? String(main.price.outputUSDPerMTok) : "",
    },
    preset: (saved?.autonomy && presetOf(saved.autonomy)?.label) || "Balanced",
  };
}

const KEYD_OFF = "Key protection is off. To turn it back on, run this in Terminal:";
const sameAddress = (a: string | undefined, b: string) => {
  try {
    return !!a && new URL(a).href.replace(/\/+$/, "") === new URL(b).href.replace(/\/+$/, "");
  } catch {
    return false;
  }
};

// First-run setup (design-v2 §11 A0): one decision per screen, dot as the narrator, and nothing
// but the column's content changing from one step to the next.
export function Onboarding(props: OnboardingProps) {
  const { api, control, phone, keys, index, saved } = props;
  const { progress } = control;
  const step = progress.step;
  const [draft, setDraft] = useState(() => draftOf(progress, saved));
  const checkModels = props.onCheckModels;
  useEffect(() => {
    if (draft.provider) checkModels?.();
  }, [draft.provider, checkModels]);
  const change = (next: Partial<SetupDraft>) => setDraft((now) => ({ ...now, ...next }));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState(false);
  const secret = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const chatgpt = useChatgpt(api, draft.kind === "chatgpt" && (step === "key" || step === "model"));
  const claude = useClaudeCode(
    api,
    draft.kind === "claude-code" && (step === "key" || step === "model"),
  );
  // The models of the plan app chosen here, which the main model is one of.
  const appModels = draft.kind === "claude-code" ? claude.models : chatgpt.models;

  // The column's content leaves before the next comes in; the rest of the page stays put.
  const [shown, setShown] = useState(step);
  const column = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step === shown) return;
    return afterMotion([column.current], () => setShown(step), false);
  }, [step, shown]);
  const arrived = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves to each new step's title
  useEffect(() => {
    if (arrived.current) title.current?.focus({ preventScroll: true });
    arrived.current = true;
  }, [shown]);

  const spec = providerById(draft.provider);
  const stored = (() => {
    if (!spec) return [];
    const llm = keys.keys.filter((key) => key.kind === "llm");
    if (!spec.custom) return matchingKeys(spec, llm);
    return llm.filter(
      (key) => key.provider === spec.keyd && sameAddress(key.baseURL, draft.address),
    );
  })();
  const chosenKey =
    stored.find((key) => key.id === progress.key) ??
    stored.find((key) => key.id === saved?.main?.key) ??
    stored[0];
  const models = (index?.providers.find((row) => row.id === draft.provider)?.models ?? []).filter(
    (model) => model.tier !== "no-tools",
  );
  const catalog = draft.kind === "api" || draft.kind === "plan";
  const recommended = recommendedMain(models);
  const mainModel = catalog
    ? draft.model || (recommended?.id ?? "")
    : appKind(draft.kind)
      ? appModels.some((model) => model.id === draft.model)
        ? draft.model
        : (appModels[0]?.id ?? "")
      : draft.model.trim();
  const allModels = index?.providers.find((row) => row.id === draft.provider)?.models ?? [];
  const fastPick = catalog ? recommendedFast(allModels, mainModel) : undefined;
  const fastModel = allModels.some(
    (model) => model.id === draft.fastModel && model.id !== mainModel,
  )
    ? draft.fastModel
    : (fastPick?.id ?? "");
  const keydOff = keys.health?.online === false;

  const advance = (extra: Partial<WizardProgress> = {}) =>
    control.update((now) => {
      const to = nextStep(now);
      return { ...now, ...extra, step: to, back: to === now.back ? undefined : now.back };
    });
  const run = async (work: () => Promise<string | null>, then: () => void) => {
    setBusy(true);
    setProblem(null);
    const failed = await work();
    if (!alive.current) return;
    setBusy(false);
    if (failed) setProblem(failed);
    else then();
  };
  const go = (to: WizardStep, back?: WizardProgress["back"]) => {
    setProblem(null);
    control.go(to, back);
  };

  // The key in the field, sealed and stored; the value never enters React state.
  const saveKey = async (): Promise<{ id?: string; problem?: string }> => {
    const value = secret.current?.value.trim() ?? "";
    if (!spec || !value) return {};
    const base = {
      ...EMPTY_DRAFT,
      provider: spec.keyd as Provider,
      baseURL: spec.custom ? draft.address.trim() : (spec.baseURL ?? ""),
    };
    const check = bindingOf({
      ...base,
      id: suggestedId(
        base,
        keys.keys.map((key) => key.id),
      ),
    });
    if (!check.ok) return { problem: check.message };
    const wrong = valueProblem(value);
    if (wrong) return { problem: wrong };
    try {
      const { key } = await keys.save(check.binding, value);
      return { id: key?.id ?? check.binding.id };
    } catch (error) {
      return { problem: problemText(error) };
    }
  };
  const [keySaved, setKeySaved] = useState<string | null>(null);
  const storeKey = () =>
    run(
      async () => {
        const { id, problem: failed } = await saveKey();
        if (id && alive.current) {
          setKeySaved(id);
          setTyped(false);
          control.update((now) => ({ ...now, key: id }));
        }
        return failed ?? null;
      },
      () => {},
    );

  const mainChoice = (): RoleChoice => {
    if (draft.kind === "chatgpt" || draft.kind === "claude-code")
      return { provider: draft.kind, model: mainModel };
    if (draft.kind === "local") return { provider: draft.provider, model: mainModel };
    const key = chosenKey?.id ?? progress.key;
    return {
      provider: draft.provider,
      model: mainModel,
      ...(key ? { key } : {}),
      ...(draft.kind === "custom" && draft.plan ? { plan: true } : {}),
    };
  };
  const saveModels = () =>
    run(
      () =>
        saveSetup(
          api,
          (form) => {
            const choices = { ...form.choices, main: mainChoice() };
            const prices = { ...form.prices };
            delete prices.main;
            delete prices.fast;
            if (draft.kind === "custom" && !draft.plan) prices.main = draft.price;
            if (catalog && draft.fast && fastModel)
              choices.fast = { provider: draft.provider, model: fastModel, key: mainChoice().key };
            else delete choices.fast;
            return { ...form, choices, prices };
          },
          { subscriptionModels: appModels },
        ),
      () => {
        props.onSaved();
        advance();
      },
    );
  const policy = (
    AUTONOMY_PRESETS.find((preset) => preset.label === draft.preset) ?? AUTONOMY_PRESETS[0]
  )?.policy as AutonomyPolicy;
  const savePermissions = () =>
    run(
      () =>
        saveSetup(api, (form) => ({ ...form, autonomy: policy }), {
          autonomy: policy,
          subscriptionModels: appModels,
        }),
      () => {
        props.onSaved();
        advance();
      },
    );

  const keyStep = () => {
    if (draft.kind === "chatgpt")
      return { reason: chatgpt.canStart ? undefined : "Sign in with ChatGPT first", run: advance };
    if (draft.kind === "claude-code")
      return {
        reason: claude.canStart ? undefined : "Set up Claude Code first",
        run: () => advance({ provider: draft.provider }),
      };
    if (draft.kind === "local") return { run: () => advance({ provider: draft.provider }) };
    if (draft.kind === "custom" && !/^https:\/\//.test(draft.address.trim()))
      return { reason: "Enter the server's https:// address first", run: () => {} };
    if (typed)
      return {
        run: async () => {
          setBusy(true);
          setProblem(null);
          const { id, problem: failed } = await saveKey();
          if (!alive.current) return;
          setBusy(false);
          if (failed || !id) return setProblem(failed ?? "The key couldn't be saved. Try again.");
          setKeySaved(id);
          setTyped(false);
          advance({ provider: draft.provider, key: id });
        },
      };
    if (keydOff) return { reason: "Key protection is off right now", run: () => {} };
    // A key saved on paste counts before the list of keys has caught up with it.
    const key = chosenKey?.id ?? keySaved;
    if (!key) return { reason: "Paste a key first", run: () => {} };
    return { run: () => advance({ provider: draft.provider, key }) };
  };

  const modelName = (() => {
    const id = saved?.main?.model ?? mainModel;
    if (appKind(draft.kind)) return appModels.find((model) => model.id === id)?.name ?? id;
    return allModels.find((model) => model.id === id)?.name ?? id;
  })();

  type View = {
    title: string;
    sub: string;
    body: ReactNode;
    primary: string;
    icon?: "power";
    reason?: string;
    run(): void;
  };
  const view = ((): View => {
    switch (shown) {
      case "welcome":
        return {
          title: "Hi, I'm dot.",
          sub: "I do tasks on my own computer, right here on your Mac. You can watch, step in or stop me at any time.",
          body: <WelcomeStep />,
          primary: "Get started",
          run: () => advance(),
        };
      case "thinks":
        return {
          title: "How should dot think?",
          sub: "Choose where the AI comes from. You can change this later in Settings.",
          body: (
            <ThinksStep
              value={draft.kind}
              chatgptReason={
                index?.subscriptions.find((row) => row.id === "chatgpt")?.available === false
                  ? "Not available on this Mac yet."
                  : undefined
              }
              claudeReason={
                index?.subscriptions.find((row) => row.id === "claude-code")?.available === false
                  ? "Not available on this Mac yet."
                  : undefined
              }
              onChange={(kind) => {
                const main = saved?.main;
                change({
                  kind,
                  provider:
                    main && kindOf(main.provider) === kind ? main.provider : FIRST_PROVIDER[kind],
                  model: "",
                  fastModel: "",
                });
                setKeySaved(null);
                setTyped(false);
              }}
            />
          ),
          primary: "Continue",
          run: () =>
            advance({
              kind: draft.kind,
              provider: draft.provider,
              ...(draft.kind !== kindOf(progress.provider) ? { key: undefined } : {}),
            }),
        };
      case "key": {
        const { reason, run: next } = keyStep();
        const pick = (provider: string) => {
          change({ provider, model: "", fastModel: "" });
          setKeySaved(null);
          if (secret.current) secret.current.value = "";
          setTyped(false);
        };
        const body =
          draft.kind === "chatgpt" ? (
            <ChatgptPanel account={chatgpt} />
          ) : draft.kind === "claude-code" ? (
            <ClaudeCodePanel claude={claude} titled={false} />
          ) : draft.kind === "local" ? (
            <LocalStep value={draft.provider} onChange={pick} />
          ) : draft.kind === "custom" ? (
            <CustomKeyStep
              flavor={
                CUSTOM_PROVIDERS.some((p) => p.id === draft.provider)
                  ? draft.provider
                  : "openai-compatible"
              }
              address={draft.address}
              onFlavor={pick}
              onAddress={(address) => change({ address })}
              secret={secret}
              saved={keySaved ?? (typed ? null : (chosenKey?.id ?? null))}
              unavailable={keydOff ? KEYD_OFF : undefined}
              onTyped={(now) => {
                setTyped(now);
                if (now) setKeySaved(null);
              }}
            />
          ) : (
            <KeyStep
              kind={draft.kind}
              provider={draft.provider}
              onProvider={pick}
              secret={secret}
              saved={keySaved ?? (typed ? null : (chosenKey?.id ?? null))}
              busy={busy}
              unavailable={keydOff ? KEYD_OFF : undefined}
              models={models}
              onTyped={(now) => {
                setTyped(now);
                if (now) setKeySaved(null);
              }}
              onPaste={() => requestAnimationFrame(() => void storeKey())}
            />
          );
        const copy = KEY_COPY[draft.kind];
        return {
          title: copy.title,
          sub: typeof copy.sub === "string" ? copy.sub : copy.sub(keyHome(keys.health)),
          body,
          primary: "Continue",
          reason,
          run: next,
        };
      }
      case "model":
        return {
          title: "Which model should do the work?",
          sub: appKind(draft.kind)
            ? "One of your plan's models. Change it any time in Settings."
            : catalog
              ? "Choose from this provider’s model list. Change it any time in Settings."
              : "Type the model's name as your server shows it.",
          body: (
            <ModelStep
              kind={draft.kind}
              provider={draft.provider}
              loading={catalog && props.modelsLoading}
              onRefresh={catalog ? props.onRefreshModels : undefined}
              catalogAvailable={!!index?.catalog}
              catalogStatus={catalog ? index?.catalog : undefined}
              models={appKind(draft.kind) ? [] : models}
              allModels={allModels}
              subscriptionModels={appModels}
              main={mainModel}
              recommended={recommended?.id}
              typedModel={draft.model}
              fast={draft.fast && !!fastModel}
              fastAvailable={!!fastPick}
              fastModel={fastModel}
              plan={draft.plan}
              price={draft.price}
              onMain={(model) => change({ model })}
              onFast={(fast) => change({ fast })}
              onFastModel={(fastModel) => change({ fastModel })}
              onPlan={(plan) => change({ plan })}
              onPrice={(price) => change({ price })}
            />
          ),
          primary: "Continue",
          reason: mainModel ? undefined : "Choose a model first",
          run: saveModels,
        };
      case "permissions":
        return {
          title: "How often should dot check with you?",
          sub: "Everyday work on dot's own computer always just runs.",
          body: <PermissionsStep value={draft.preset} onChange={(preset) => change({ preset })} />,
          primary: "Continue",
          run: savePermissions,
        };
      case "turn-on":
        return {
          title: "You're all set.",
          sub: props.turnOn
            ? "Turn on dot's computer to start. The first start takes about a minute."
            : "Your computer is on. dot is ready when you are.",
          body: (
            <SummaryStep
              rows={[
                {
                  icon: "key-round",
                  label: "Thinks with",
                  value: thinksWith(
                    draft.kind,
                    draft.provider,
                    draft.address ||
                      keys.keys.find((key) => key.id === (progress.key ?? saved?.main?.key))
                        ?.baseURL,
                  ),
                  change: () => go("thinks", "turn-on"),
                },
                {
                  icon: "cpu",
                  label: "Model",
                  value: modelName || "Not chosen yet",
                  change: () => go("model", "turn-on"),
                },
                {
                  icon: "sliders-horizontal",
                  label: "Checks with you",
                  value: (saved?.autonomy && presetOf(saved.autonomy)?.label) ?? draft.preset,
                  change: () => go("permissions", "turn-on"),
                },
              ]}
            />
          ),
          primary: props.turnOn ? "Turn on your computer" : "Done",
          icon: props.turnOn ? "power" : undefined,
          reason: props.turnOn?.reason,
          run: () => {
            props.turnOn?.run();
            control.finish();
          },
        };
    }
  })();

  const n = stepNumber(step);
  const progressBars = <Progress step={step} kind={draft.kind} phone={phone} hidden={n === 0} />;
  const primary = (
    <Button
      variant="primary"
      size={phone ? "xxl" : "lg"}
      icon={view.icon}
      className="onboarding-primary"
      busy={busy}
      disabledReason={shown !== step ? undefined : view.reason}
      onClick={() => {
        if (shown === step) view.run();
      }}
    >
      {view.primary}
    </Button>
  );
  const back = () => go(previousStep(step));
  const footer = (
    <div className="onboarding-footer">
      {!phone && shown !== "welcome" && (
        <Button
          variant="quiet"
          size="lg"
          icon="chevron-left"
          className="onboarding-back"
          onClick={back}
        >
          Back
        </Button>
      )}
      {primary}
    </div>
  );

  return (
    <div className="onboarding" data-layout={phone ? "phone" : "desk"}>
      {phone ? (
        <div className="onboarding-head">
          {step !== "welcome" ? (
            <IconButton icon="chevron-left" label="Back" size={44} onClick={back} />
          ) : (
            <span className="onboarding-head-spacer" />
          )}
          {progressBars}
          <Button variant="quiet" size="lg" onClick={control.later}>
            Later
          </Button>
        </div>
      ) : (
        <header className="onboarding-bar">
          <span className="bar-wordmark">localDot</span>
          <Button variant="quiet" onClick={control.later}>
            Finish later
          </Button>
        </header>
      )}
      <div className="onboarding-scroll">
        <div className="onboarding-page">
          {!phone && progressBars}
          {props.showDot ? (
            <PresenceSlot name="intro" className="onboarding-dot" />
          ) : (
            <span className="onboarding-dot" aria-hidden="true" />
          )}
          <div
            ref={column}
            className="onboarding-column"
            data-leaving={shown !== step || undefined}
            aria-busy={shown !== step || undefined}
          >
            <h1 ref={title} className="onboarding-title" tabIndex={-1}>
              {view.title}
            </h1>
            <p className="onboarding-sub">{view.sub}</p>
            <div className="onboarding-content">{view.body}</div>
            {problem && (
              <p className="onboarding-problem" role="alert">
                <Icon name="circle-alert" size={12} />
                {problem}
              </p>
            )}
          </div>
          {!phone && footer}
        </div>
      </div>
      {phone && <div className="onboarding-foot">{primary}</div>}
    </div>
  );
}

// A key's sub-line names where it is kept, from keyd's vault (keyHome).
const KEY_COPY: Record<ThinkKind, { title: string; sub: string | ((home: string) => string) }> = {
  api: {
    title: "Add your API key",
    sub: (home) => `Paste a key from your provider. It stays ${home}.`,
  },
  plan: {
    title: "Add your plan's key",
    sub: (home) => `Choose your plan, then paste its key. It stays ${home}.`,
  },
  chatgpt: {
    title: "Set up your ChatGPT plan",
    sub: "dot uses your ChatGPT plan. Set it up once on this Mac.",
  },
  "claude-code": {
    title: "Set up Claude Code",
    sub: "dot works through your own Claude Code on this Mac. Install it and sign in there, once.",
  },
  local: {
    title: "Which app runs your model?",
    sub: "Free and private. dot talks to the app running on this Mac.",
  },
  custom: {
    title: "Add your server",
    sub: (home) => `Any OpenAI- or Anthropic-compatible server. Its key stays ${home}.`,
  },
};

function Progress({
  step,
  kind,
  phone,
  hidden,
}: {
  step: WizardStep;
  kind: ThinkKind;
  phone: boolean;
  hidden: boolean;
}) {
  const n = stepNumber(step);
  const current = WIZARD_STEPS[n - 1];
  const label = current
    ? `Step ${n} of ${WIZARD_STEPS.length} · ${stepTitle(current, kind)}`
    : undefined;
  return (
    <div className="onboarding-progress" data-hidden={hidden || undefined}>
      <ol className="onboarding-bars" aria-label={label}>
        {WIZARD_STEPS.map((id, i) => (
          <li
            key={id}
            className="onboarding-bar-step"
            data-state={i + 1 < n ? "done" : i + 1 === n ? "current" : undefined}
          />
        ))}
      </ol>
      {!phone && (
        <span className="onboarding-step" aria-hidden="true">
          {label}
        </span>
      )}
    </div>
  );
}
