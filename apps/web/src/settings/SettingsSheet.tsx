import type { AutonomyPolicy } from "@localdot/protocol";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ownedByPicker } from "../lib/dismiss.ts";
import { type AppearanceControl, AppearancePicker } from "../onboarding/AppearancePicker.tsx";
import { ChatgptPanel } from "./ChatgptPanel.tsx";
import type {
  ModelRole,
  PickerKey,
  ProviderModels,
  RoleChoice,
  SubscriptionModel,
} from "./choices.ts";
import { RoleEditor } from "./RoleEditor.tsx";
import { SafetySettings } from "./SafetySettings.tsx";
import type { ChatgptControls } from "./useChatgpt.ts";
import type { RulesView } from "./useRules.ts";
import "./settings.css";

export interface SettingsSheetProps {
  focusSection?: "models" | "autonomy";
  appearance?: AppearanceControl;
  open: boolean;
  suspended?: boolean;
  choices: Partial<Record<ModelRole, RoleChoice>>;
  providers: readonly ProviderModels[];
  keys: readonly PickerKey[];
  keyLayer: "online" | "offline" | "unknown";
  subscriptionModels?: readonly SubscriptionModel[];
  chatgpt?: ChatgptControls;
  catalog: "loading" | "ready" | "empty" | "stale" | "refreshing" | "offline";
  dirty: boolean;
  busy?: boolean;
  error?: string | null;
  onClose(): void;
  onChange(role: ModelRole, value: RoleChoice | undefined): void;
  onKeys(role: ModelRole, provider: string, trigger: HTMLButtonElement): void;
  onRefresh?(): void;
  save?: { enabled: boolean; run(): void };
  stop?: { label: string; enabled: boolean; run(): void };
  taskControls?: ReactNode;
  autonomy?: AutonomyPolicy;
  onAutonomy?(value: AutonomyPolicy): void;
  rules?: RulesView;
  manualPrices?: Partial<Record<ModelRole, { input: string; output: string }>>;
  onPrice?(role: ModelRole, value: { input: string; output: string }): void;
  budget?: {
    value: string;
    useDefault: boolean;
    defaultUSD: number | null;
    change(value: string, useDefault: boolean): void;
  };
  onReload?(): void;
  validation?: readonly string[] | null;
  loading?: boolean;
}
const CATALOG_MESSAGE: Record<SettingsSheetProps["catalog"], string> = {
  loading: "Loading the model catalog…",
  ready: "Model catalog available.",
  empty: "The model catalog is empty.",
  stale: "The saved catalog is older. Your selections are retained while you refresh.",
  refreshing: "Refreshing the model catalog…",
  offline: "The model catalog is unavailable right now. Your choices are kept.",
};
export function SettingsSheet(props: SettingsSheetProps) {
  const panel = useRef<HTMLElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const resume = useRef<HTMLElement | null>(null);
  const active = props.open && !props.suspended;
  const [confirming, setConfirming] = useState<"close" | "reload" | null>(null);
  const latest = useRef({
    onClose: props.onClose,
    onReload: props.onReload,
    dirty: props.dirty,
    confirming,
  });
  const focusedSection = useRef(false);
  useLayoutEffect(() => {
    latest.current = {
      onClose: props.onClose,
      onReload: props.onReload,
      dirty: props.dirty,
      confirming,
    };
  }, [props.onClose, props.onReload, props.dirty, confirming]);
  useLayoutEffect(() => {
    if (props.open)
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    else setConfirming(null);
  }, [props.open]);
  useEffect(() => {
    if (props.open) return;
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected && !target.closest("[inert], [hidden]")) target.focus();
  }, [props.open]);
  useEffect(() => {
    if (!props.dirty) setConfirming(null);
  }, [props.dirty]);
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);
  // Safari does not focus a tapped button, so a trigger names itself as the place to come back to.
  const confirm = useCallback((action: "close" | "reload", trigger?: HTMLElement) => {
    if (!latest.current.dirty)
      return action === "close" ? latest.current.onClose() : latest.current.onReload?.();
    if (!latest.current.confirming)
      resume.current =
        trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setConfirming(action);
    keep.current?.focus();
  }, []);
  const requestClose = useCallback(() => confirm("close"), [confirm]);
  const keepEditing = useCallback(() => {
    setConfirming(null);
    const target = resume.current;
    resume.current = null;
    if (target?.isConnected && panel.current?.contains(target) && target !== keep.current)
      target.focus();
    else panel.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  useEffect(() => {
    if (!active) return;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !ownedByPicker(event)) {
        event.preventDefault();
        if (latest.current.confirming) keepEditing();
        else requestClose();
      }
      if (event.key !== "Tab" || !panel.current) return;
      const items = [
        ...panel.current.querySelectorAll<HTMLElement>(
          "button:enabled, input:enabled, select:enabled, a[href]",
        ),
      ].filter((item) => !item.closest("[hidden], [inert]"));
      const first = items[0],
        last = items.at(-1);
      if (
        event.shiftKey &&
        (!panel.current.contains(document.activeElement) || document.activeElement === first)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (!panel.current.contains(document.activeElement) || document.activeElement === last)
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, keepEditing, requestClose]);
  useEffect(() => {
    if (!props.open) focusedSection.current = false;
    if (!active || props.loading || focusedSection.current || props.focusSection !== "autonomy")
      return;
    const section = panel.current?.querySelector<HTMLElement>(".safety-settings");
    if (!section) return;
    section.scrollIntoView?.({ block: "start" });
    section.querySelector<HTMLSelectElement>("select")?.focus();
    focusedSection.current = true;
  }, [active, props.open, props.loading, props.focusSection]);
  const saveBlocked = !props.save?.enabled || props.busy;
  const problems = props.validation?.length ? props.validation : null;
  const saveReason =
    [
      problems && "settings-problems",
      props.error && "settings-error",
      props.loading && "settings-loading",
      (props.catalog === "refreshing" || props.catalog === "offline") && "settings-catalog-state",
    ]
      .filter(Boolean)
      .join(" ") ||
    (!props.dirty && "settings-state");
  return (
    <>
      <div
        className="settings-backdrop"
        hidden={!active}
        aria-hidden="true"
        onClick={(event) => {
          if (event.target === event.currentTarget) requestClose();
        }}
      />
      <section
        ref={panel}
        id="settings-sheet"
        className="settings-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        hidden={!active}
        inert={!active}
      >
        <div className="settings-heading">
          <header>
            <h2 id="settings-title">Models and settings</h2>
            <button type="button" onClick={requestClose} aria-label="Close settings">
              ×
            </button>
          </header>
          {props.stop && (
            <div className="settings-actions">
              <span>Computer controls</span>
              <button
                type="button"
                aria-disabled={!props.stop.enabled || undefined}
                onClick={() => {
                  if (props.stop?.enabled) props.stop.run();
                }}
              >
                {props.stop.label}
              </button>
            </div>
          )}
        </div>
        {active && props.taskControls}
        <div className="settings-body">
          {props.appearance && <AppearancePicker appearance={props.appearance} inSettings />}
          <p>Saved settings apply to future tasks. The current task keeps its models.</p>
          <p id="settings-state" role="status">
            {props.dirty ? "Unsaved choices" : "Saved choices"}
          </p>
          {props.loading && (
            <p id="settings-loading" role="status">
              Loading saved settings…
            </p>
          )}
          <div className="settings-catalog">
            <p id="settings-catalog-state" role="status">
              {CATALOG_MESSAGE[props.catalog]}
            </p>
            {props.onRefresh && (
              <button
                type="button"
                disabled={props.busy || props.catalog === "refreshing"}
                onClick={props.onRefresh}
              >
                {props.catalog === "offline" ? "Try again" : "Refresh catalog"}
              </button>
            )}
          </div>
          {active && props.choices.main?.provider === "chatgpt" && props.chatgpt && (
            <ChatgptPanel account={props.chatgpt} />
          )}
          {(["main", "fast", "local"] as const).map((role) => (
            <RoleEditor
              key={role}
              modelRole={role}
              value={props.choices[role]}
              providers={props.providers}
              keys={props.keys}
              keyLayer={props.keyLayer}
              subscriptionModels={props.subscriptionModels}
              disabled={props.busy || props.loading}
              onChange={(value) => props.onChange(role, value)}
              onKeys={props.onKeys}
              manualPrice={props.manualPrices?.[role]}
              onPrice={(value) => props.onPrice?.(role, value)}
              inactive={role !== "main" && props.choices.main?.provider === "chatgpt"}
            />
          ))}
          {props.autonomy && props.onAutonomy && (
            <SafetySettings
              value={props.autonomy}
              disabled={props.busy || props.loading}
              onChange={props.onAutonomy}
              rules={props.rules}
            />
          )}
          {props.budget && props.choices.main?.provider !== "chatgpt" && (
            <fieldset className="role-editor" disabled={props.busy || props.loading}>
              <legend>Task spending ceiling</legend>
              <p>
                The ceiling applies to a new API task. It does not guarantee a provider's final
                bill. Existing tasks keep their ceiling.
              </p>
              <label className="role-enabled">
                <input
                  type="checkbox"
                  checked={props.budget.useDefault}
                  onChange={(event) =>
                    props.budget?.change(props.budget.value, event.target.checked)
                  }
                />
                Use the configured default
              </label>
              <p>
                {props.budget.defaultUSD === null
                  ? "The configured default is unavailable."
                  : `Configured default: $${props.budget.defaultUSD} USD per task.`}
              </p>
              {!props.budget.useDefault && (
                <label>
                  <span>Task ceiling — USD</span>
                  <input
                    inputMode="decimal"
                    required
                    maxLength={64}
                    value={props.budget.value}
                    onChange={(event) => props.budget?.change(event.target.value, false)}
                  />
                </label>
              )}
              {props.choices.main?.provider === "chatgpt" && (
                <p>
                  The ChatGPT plan uses subscription limits. This stored API ceiling is inactive.
                </p>
              )}
            </fieldset>
          )}
          {problems && (
            <div id="settings-problems" className="settings-problems" role="status">
              <p>Before you can save:</p>
              <ul>
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
          {props.error && (
            <p id="settings-error" role="alert">
              {props.error}
            </p>
          )}
          <div className="settings-commit">
            {props.onReload && (
              <button
                type="button"
                disabled={props.busy}
                onClick={(event) => confirm("reload", event.currentTarget)}
              >
                Reload saved settings
              </button>
            )}
            {props.save && (
              <button
                type="button"
                className="settings-save"
                aria-disabled={saveBlocked || undefined}
                aria-describedby={(saveBlocked && !props.busy && saveReason) || undefined}
                onClick={() => {
                  if (!saveBlocked) props.save?.run();
                }}
              >
                {props.busy ? "Saving…" : "Save settings"}
              </button>
            )}
          </div>
        </div>
        {confirming && (
          <div className="settings-discard">
            <p role="alert">Discard unsaved changes?</p>
            <div>
              <button ref={keep} type="button" onClick={keepEditing}>
                Keep editing
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirming === "close") return props.onClose();
                  keepEditing();
                  props.onReload?.();
                }}
              >
                Discard
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
