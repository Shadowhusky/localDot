import { useEffect, useLayoutEffect, useRef } from "react";
import type { KeyRecord } from "../keys/keys-api.ts";
import type { ModelRole, PickerModel, ProviderModels, RoleChoice } from "./choices.ts";
import { RoleEditor } from "./RoleEditor.tsx";
import "./settings.css";

export interface SettingsSheetProps {
  open: boolean;
  suspended?: boolean;
  choices: Partial<Record<ModelRole, RoleChoice>>;
  providers: readonly ProviderModels[];
  keys: readonly KeyRecord[];
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
      <p>Saved settings apply to future tasks. The current task keeps its models.</p>
      <p role="status">{props.dirty ? "Unsaved choices" : "Saved choices"}</p>
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
          disabled={props.busy}
          onChange={(value) => props.onChange(role, value)}
          onKeys={props.onKeys}
        />
      ))}
      {props.error && <p role="alert">{props.error}</p>}
      {props.save && (
        <button type="button" disabled={!props.save.enabled || props.busy} onClick={props.save.run}>
          {props.busy ? "Saving…" : "Save settings"}
        </button>
      )}
    </section>
  );
}
