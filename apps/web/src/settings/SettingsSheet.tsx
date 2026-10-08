import type { AutonomyPolicy } from "@localdot/protocol";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Knowledge } from "../agent/useKnowledge.ts";
import {
  KEYS_DESCRIPTION,
  KEYS_TITLE,
  KeysPanel,
  type KeysPanelProps,
} from "../keys/KeysSheet.tsx";
import type { AppearanceControl } from "../onboarding/AppearancePicker.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Icon } from "../ui/Icon.tsx";
import { MoneyField } from "../ui/MoneyField.tsx";
import { matches, PHONE, useMediaQuery } from "../ui/media.ts";
import { RadioCards } from "../ui/RadioCards.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Sheet, useConfirmDiscard } from "../ui/Sheet.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { AutonomyMatrix } from "./AutonomyMatrix.tsx";
import { ChatgptPanel } from "./ChatgptPanel.tsx";
import {
  type ModelRole,
  type PickerKey,
  type ProviderModels,
  planOnly,
  type RoleChoice,
  type SubscriptionModel,
} from "./choices.ts";
import { CHATGPT } from "./chooser.ts";
import { KnowledgeSection } from "./KnowledgeSection.tsx";
import { RoleCard } from "./RoleCard.tsx";
import type { ChatgptControls } from "./useChatgpt.ts";
import type { RulesView } from "./useRules.ts";
import "./settings.css";

// How long "Saved" stays in the footer after a save.
const SAVED_MS = 1200;

export type CatalogState = "loading" | "ready" | "empty" | "stale" | "refreshing" | "offline";

// Keys slid over Settings, with a Back to it.
export type KeysPage = Omit<KeysPanelProps, "active" | "onHolding"> & { onBack(): void };

export interface SettingsSheetProps {
  open: boolean;
  keysPage?: KeysPage;
  focusSection?: "models" | "autonomy";
  appearance?: AppearanceControl;
  choices: Partial<Record<ModelRole, RoleChoice>>;
  providers: readonly ProviderModels[];
  keys: readonly PickerKey[];
  keyLayer: "online" | "offline" | "unknown";
  subscriptionModels?: readonly SubscriptionModel[];
  chatgpt?: ChatgptControls;
  catalog: CatalogState;
  // When the model list was last fetched.
  catalogAt?: string;
  dirty: boolean;
  busy?: boolean;
  error?: string | null;
  loading?: boolean;
  validation?: readonly string[] | null;
  onClose(): void;
  onChange(role: ModelRole, value: RoleChoice | undefined): void;
  onKeys(role: ModelRole, provider: string, trigger: HTMLButtonElement): void;
  onRefresh?(): void;
  onReload?(): void;
  save?: { enabled: boolean; run(): void };
  autonomy?: AutonomyPolicy;
  savedAutonomy?: AutonomyPolicy;
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
  knowledge?: Knowledge;
  // A phone's sheet covers the page and its Stop, so it carries one, with what Stop reports.
  stop?: { label: string; enabled: boolean; run(): void };
  taskControls?: ReactNode;
}

function ago(at: string | undefined, now: number): string | null {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) return null;
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
}

function catalogLine(state: CatalogState, at: string | undefined): string {
  switch (state) {
    case "loading":
      return "Loading the model list…";
    case "refreshing":
      return "Refreshing the model list…";
    case "offline":
      return "The model list can't be reached. Your choices are kept.";
    case "empty":
      return "The model list is empty.";
    case "stale": {
      const when = ago(at, Date.now());
      return when ? `Model list from ${when} may be out of date` : "Model list may be out of date";
    }
    default: {
      const when = ago(at, Date.now());
      return when ? `Model list updated ${when}` : "Model list ready";
    }
  }
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="settings-section" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="settings-section-title">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function SettingsSheet(props: SettingsSheetProps) {
  const statusId = useId();
  const phone = useMediaQuery(PHONE);
  const [saved, setSaved] = useState(false);
  // Set from a press of Save until that save is done; the account's own steps are busy too.
  const [saving, setSaving] = useState(false);
  const sawBusy = useRef(false);
  const [keysHolding, setKeysHolding] = useState(false);
  // Closing, the sheet leaves on the page it showed.
  const keysPage = useRef(props.keysPage);
  if (props.open) keysPage.current = props.keysPage;

  useEffect(() => {
    if (!saving) return;
    if (props.busy) {
      sawBusy.current = true;
      return;
    }
    if (!sawBusy.current) return;
    sawBusy.current = false;
    setSaving(false);
    if (!props.dirty && !props.error) setSaved(true);
  }, [saving, props.busy, props.dirty, props.error]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

  useEffect(() => {
    if (props.dirty) setSaved(false);
  }, [props.dirty]);

  // Once the saved settings are in, focus goes to the main model's provider, or to the requested
  // section, unless the person has already moved it from where the sheet put it on opening.
  const placed = useRef<Element | null | undefined>(undefined);
  useEffect(() => {
    if (!props.open) {
      placed.current = undefined;
      return;
    }
    const sheet = document
      .getElementById("settings-sheet-body")
      ?.closest<HTMLElement>("[role=dialog]");
    if (!sheet) return;
    if (placed.current === undefined) placed.current = document.activeElement;
    if (props.loading || placed.current === null) return;
    const now = document.activeElement;
    const moved = now !== placed.current && now !== sheet && sheet.contains(now);
    placed.current = null;
    if (moved) return;
    if (props.focusSection === "autonomy") {
      const section = sheet.querySelector<HTMLElement>("#settings-autonomy");
      section?.scrollIntoView?.({ block: "start" });
      section?.querySelector<HTMLElement>("[role=radio][tabindex='0']")?.focus();
    } else if (!matches("(pointer: coarse)")) {
      sheet.querySelector<HTMLElement>("[data-role=main] [role=combobox]")?.focus();
    }
  }, [props.open, props.loading, props.focusSection]);

  const lockReason = props.loading
    ? "Loading saved settings"
    : props.busy
      ? "Wait for saving to finish"
      : undefined;
  const problems = props.validation?.length ? props.validation : null;
  const saveReason = props.loading
    ? "Settings are still loading"
    : !props.dirty
      ? "No changes to save"
      : problems
        ? "Fix what's listed first"
        : props.catalog === "refreshing"
          ? "Wait for the model list to refresh"
          : props.catalog === "offline"
            ? "The model list can't be reached"
            : !props.save?.enabled
              ? "Can't save right now"
              : undefined;

  const status = props.loading ? (
    "Loading saved settings…"
  ) : saving ? (
    "Saving…"
  ) : problems ? (
    <>
      <span>Before you can save:</span>
      <ul className="settings-problems">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </>
  ) : props.dirty ? (
    <span className="settings-footer-line">
      <Badge kind="dot" tone="attention" label="Unsaved" />
      Unsaved changes
    </span>
  ) : saved ? (
    <span className="settings-footer-line">
      <Icon name="check" size={12} />
      Saved
    </span>
  ) : (
    "All changes saved"
  );

  const footer = (
    <div className="settings-footer">
      {props.error && !props.loading && !saving ? (
        <p id={statusId} key="error" className="settings-footer-status" role="alert" data-error="">
          <Icon name="circle-alert" size={12} />
          {props.error}
        </p>
      ) : (
        <div id={statusId} key="status" className="settings-footer-status" role="status">
          {status}
        </div>
      )}
      {props.dirty && props.onReload && (
        <Revert disabledReason={lockReason} onRevert={props.onReload} />
      )}
      {props.save && (
        <Button
          variant="primary"
          busy={saving}
          disabledReason={
            saving ? undefined : (saveReason ?? (props.busy ? "Wait a moment" : undefined))
          }
          aria-describedby={statusId}
          onClick={() => {
            setSaving(true);
            props.save?.run();
          }}
        >
          Save
        </Button>
      )}
    </div>
  );

  if (keysPage.current) {
    const { onBack, ...panel } = keysPage.current;
    return (
      <Sheet
        open={props.open}
        onClose={props.onClose}
        dirty={props.dirty || keysHolding}
        page="keys"
        back={{ label: "Settings", onBack }}
        title={KEYS_TITLE}
        description={KEYS_DESCRIPTION}
        closeLabel="Close settings"
      >
        <KeysPanel {...panel} active={props.open} onHolding={setKeysHolding} />
      </Sheet>
    );
  }
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      dirty={props.dirty}
      title="Settings"
      description="Changes apply to new tasks. A running task keeps its models."
      closeLabel="Close settings"
      footer={footer}
    >
      <div id="settings-sheet-body" className="settings-body">
        {phone && (
          // What Stop reports stays after Stop itself has gone.
          <div className="settings-stop">
            {props.stop && (
              <div className="settings-inline">
                <p className="settings-note">Your computer</p>
                <Button
                  icon="square"
                  disabledReason={props.stop.enabled ? undefined : "Not available right now"}
                  onClick={() => props.stop?.run()}
                >
                  {props.stop.label}
                </Button>
              </div>
            )}
            {props.taskControls}
          </div>
        )}
        {props.loading ? (
          <Skeleton loading shape="block" height="320px" className="settings-loading" />
        ) : (
          <SettingsSections {...props} />
        )}
      </div>
    </Sheet>
  );
}

function SettingsSections(props: SettingsSheetProps) {
  const chatgptMain = props.choices.main?.provider === CHATGPT;
  return (
    <>
      <Section id="settings-models" title="Models">
        {chatgptMain && props.chatgpt && <ChatgptPanel account={props.chatgpt} />}
        {(["main", "fast", "local"] as const).map((role) => (
          <RoleCard
            key={role}
            modelRole={role}
            value={props.choices[role]}
            providers={props.providers}
            keys={props.keys}
            keyLayer={props.keyLayer}
            subscriptionModels={props.subscriptionModels}
            inactive={role !== "main" && chatgptMain}
            manualPrice={props.manualPrices?.[role]}
            onChange={(value) => props.onChange(role, value)}
            onKeys={props.onKeys}
            onPrice={(value) => props.onPrice?.(role, value)}
          />
        ))}
        <div className="settings-inline">
          <p className="settings-note" role="status">
            {catalogLine(props.catalog, props.catalogAt)}
          </p>
          {props.onRefresh && (
            <Button
              variant="quiet"
              size="sm"
              busy={props.catalog === "refreshing"}
              disabledReason={props.busy ? "Wait for saving to finish" : undefined}
              onClick={props.onRefresh}
            >
              {props.catalog === "offline" ? "Try again" : "Refresh"}
            </Button>
          )}
        </div>
      </Section>

      {props.autonomy && props.onAutonomy && (
        <Section id="settings-autonomy" title="When dot checks with you">
          <AutonomyMatrix
            value={props.autonomy}
            saved={props.savedAutonomy}
            onChange={props.onAutonomy}
            rules={props.rules}
          />
        </Section>
      )}

      {props.budget && !chatgptMain && (
        <Section id="settings-spending" title="Spending">
          {planOnly(props.choices) ? (
            <p className="settings-note">Your plan's own limits apply, so no limit is needed.</p>
          ) : (
            <Spending budget={props.budget} />
          )}
        </Section>
      )}

      {props.knowledge && (
        <Section id="settings-knowledge" title="What dot knows">
          <KnowledgeSection knowledge={props.knowledge} />
        </Section>
      )}

      {props.appearance && (
        <Section id="settings-appearance" title="Appearance">
          <Appearance appearance={props.appearance} />
        </Section>
      )}
    </>
  );
}

function Revert({ disabledReason, onRevert }: { disabledReason?: string; onRevert(): void }) {
  const confirmDiscard = useConfirmDiscard();
  return (
    <Button
      variant="quiet"
      disabledReason={disabledReason}
      onClick={() => confirmDiscard(onRevert)}
    >
      Revert
    </Button>
  );
}

function Spending({ budget }: { budget: NonNullable<SettingsSheetProps["budget"]> }) {
  const fallback = budget.defaultUSD;
  return (
    <div className="settings-spending">
      <Field
        label="Limit per task"
        description="Applies to new tasks. A task stops before it spends more. It isn't your bill."
      >
        <SegmentedControl
          value={budget.useDefault ? "default" : "custom"}
          items={[
            {
              value: "default",
              label: fallback === null ? "Default" : `Default ($${fallback})`,
              disabledReason: fallback === null ? "No default is set" : undefined,
            },
            { value: "custom", label: "Custom" },
          ]}
          onValueChange={(choice) => budget.change(budget.value, choice === "default")}
        />
      </Field>
      <Collapse open={!budget.useDefault}>
        <Field label="Custom limit">
          <MoneyField
            value={budget.value}
            maxLength={64}
            placeholder="2.00"
            onValueChange={(value) => budget.change(value, false)}
          />
        </Field>
      </Collapse>
    </div>
  );
}

function Appearance({ appearance }: { appearance: AppearanceControl }) {
  return (
    <Field
      label="Theme"
      description={
        appearance.saved
          ? "Applies to this browser."
          : "Applied for this visit. This browser couldn't save it."
      }
    >
      <RadioCards
        layout="tiles"
        value={appearance.value}
        onValueChange={(value) => appearance.change(value === "midnight" ? "midnight" : "graphite")}
        options={(["graphite", "midnight"] as const).map((value) => ({
          value,
          label: value === "graphite" ? "Graphite" : "Midnight",
          preview: <span className="settings-swatch" data-appearance={value} />,
        }))}
      />
    </Field>
  );
}
