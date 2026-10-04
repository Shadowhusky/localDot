import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import type { ModelRole, PickerKey, PickerModel, ProviderModels, RoleChoice } from "./choices.ts";
import { RoleEditor } from "./RoleEditor.tsx";
import "./settings.css";

export interface SettingsSheetProps {
  open: boolean;
  suspended?: boolean;
  choices: Partial<Record<ModelRole, RoleChoice>>;
  providers: readonly ProviderModels[];
  keys: readonly PickerKey[];
  keyLayer: "online" | "offline" | "unknown";
  subscriptionModels?: readonly PickerModel[];
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
  manualPrices?: Partial<Record<ModelRole, { input: string; output: string }>>;
  onPrice?(role: ModelRole, value: { input: string; output: string }): void;
  budget?: {
    value: string;
    useDefault: boolean;
    defaultUSD: number | null;
    change(value: string, useDefault: boolean): void;
  };
  onReload?(): void;
  validation?: string | null;
  loading?: boolean;
}
const CATALOG_MESSAGE: Record<SettingsSheetProps["catalog"], string> = {
  loading: "Loading the model catalog…",
  ready: "Model catalog available.",
  empty: "The model catalog is empty.",
  stale: "The saved catalog is older. Your selections are retained while you refresh.",
  refreshing: "Refreshing the model catalog…",
  offline: "Catalog connection unavailable. Your selections are retained.",
};
export function SettingsSheet(props: SettingsSheetProps) {
  const panel = useRef<HTMLElement>(null);
  const active = props.open && !props.suspended;
  const close = useRef(props.onClose);
  useLayoutEffect(() => {
    close.current = props.onClose;
  }, [props.onClose]);
  useEffect(() => {
    if (!active) return;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key !== "Tab" || !panel.current) return;
      const items = [
        ...panel.current.querySelectorAll<HTMLElement>(
          "button:enabled, input:enabled, select:enabled",
        ),
      ];
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
  }, [active]);
  return (
    <>
      <div
        className="settings-backdrop"
        hidden={!active}
        aria-hidden="true"
        onPointerDown={props.onClose}
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
            <button type="button" onClick={props.onClose} aria-label="Close settings">
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
          <p>Saved settings apply to future tasks. The current task keeps its models.</p>
          <p role="status">{props.dirty ? "Unsaved choices" : "Saved choices"}</p>
          {props.loading && <p role="status">Loading saved settings…</p>}
          <div className="settings-catalog">
            <p role="status">{CATALOG_MESSAGE[props.catalog]}</p>
            {props.onRefresh && (
              <button
                type="button"
                disabled={props.busy || props.catalog === "refreshing"}
                onClick={props.onRefresh}
              >
                Refresh catalog
              </button>
            )}
          </div>
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
          {props.budget && (
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
          {props.validation && <p role="status">{props.validation}</p>}
          {props.error && <p role="alert">{props.error}</p>}
          {props.onReload && (
            <button type="button" disabled={props.busy} onClick={props.onReload}>
              Reload saved settings
            </button>
          )}
          {props.save && (
            <button
              type="button"
              disabled={!props.save.enabled || props.busy}
              onClick={props.save.run}
            >
              {props.busy ? "Saving…" : "Save settings"}
            </button>
          )}
        </div>
      </section>
    </>
  );
}
