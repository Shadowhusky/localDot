import {
  type Accessory,
  type AutonomyPolicy,
  type LocalDotLink,
  type PersonaId,
  personaOf,
  type StartAtLoginState,
} from "@localdot/protocol";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Knowledge } from "../agent/useKnowledge.ts";
import type { ComputerUpdate } from "../cells/useComputerUpdate.ts";
import type { FreshStart } from "../cells/useFreshStart.ts";
import { spendText } from "../copy/format.ts";
import { DotLoader } from "../dot/DotLoader.tsx";
import type { ShowDotControl } from "../dot/show-dot.ts";
import { KeysPanel, type KeysPanelProps } from "../keys/KeysPanel.tsx";
import type { ApiClient } from "../lib/api.ts";
import {
  APPEARANCE_NAMES,
  type AppearanceControl,
  AppearancePicker,
} from "../onboarding/AppearancePicker.tsx";
import { PersonaPicker } from "../onboarding/PersonaPicker.tsx";
import { FreshStartButton } from "../shell/FreshStartButton.tsx";
import type { LocalDots } from "../shell/useLocalDots.ts";
import type { StreamPreferenceControl } from "../stage/stream-preference.ts";
import { STREAM_PREFERENCES } from "../stage/stream-quality.ts";
import { Button } from "../ui/Button.tsx";
import { DetailLines } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Group, GroupHead, GroupNote, GroupRow, IconTile } from "../ui/Group.tsx";
import { Icon } from "../ui/Icon.tsx";
import { matches, PHONE, REDUCED_MOTION, TOUCH, useMediaQuery } from "../ui/media.ts";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Sheet, SheetNavItem, useConfirmDiscard } from "../ui/Sheet.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";
import { routeLabel } from "../voice/words.ts";
import { AccessLinksSettings } from "./AccessLinksSettings.tsx";
import { AccessoryPicker } from "./AccessoryPicker.tsx";
import { AccountsSection } from "./AccountsSection.tsx";
import { AppUpdateSettings } from "./AppUpdateSettings.tsx";
import { AutoDot } from "./AutoDot.tsx";
import { AlwaysAllowed, AutonomyMatrix } from "./AutonomyMatrix.tsx";
import { ChatgptPanel } from "./ChatgptPanel.tsx";
import { ClaudeCodePanel } from "./ClaudeCodePanel.tsx";
import { ConnectorsSection } from "./ConnectorsSection.tsx";
import {
  type ModelRole,
  type PickerKey,
  type ProviderModels,
  planOnly,
  type RoleChoice,
  roleActive,
  type SubscriptionModel,
} from "./choices.ts";
import { CHATGPT, CLAUDE_CODE, subscription } from "./chooser.ts";
import { DotsOnThisComputer } from "./DotsOnThisComputer.tsx";
import { KnowledgeSection } from "./KnowledgeSection.tsx";
import { CheckIns, ResearchLimits, SpendingLimits } from "./Limits.tsx";
import type { RecentActivityControl } from "./memory/RecentActivity.tsx";
import type { WhatDotKnows } from "./memory/useWhatDotKnows.ts";
import { NotificationsSection } from "./NotificationsSection.tsx";
import { OtherLocalDots } from "./OtherLocalDots.tsx";
import { PurposeCheck, type PurposeCheckControl } from "./PurposeCheck.tsx";
import { RecordingStorageSettings } from "./RecordingStorage.tsx";
import { RemoteAccessSettings } from "./RemoteAccessSettings.tsx";
import { ReportProblem } from "./ReportProblem.tsx";
import { RoleCard } from "./RoleCard.tsx";
import type { ReportControl } from "./reports-api.ts";
import {
  autonomyValue,
  countValue,
  notificationsValue,
  SECTIONS,
  type SettingsSection,
  sectionTitle,
  spendingValue,
} from "./sections.ts";
import type { CheckInKey, CheckInsDraft, ResearchDraft, SpendingDraft } from "./settings-form.ts";
import type { AccountsView } from "./useAccounts.ts";
import type { AppUpdateControl } from "./useAppUpdate.ts";
import type { BrowserStatusView } from "./useBrowserStatus.ts";
import type { ChatgptControls } from "./useChatgpt.ts";
import type { ClaudeCodeControls } from "./useClaudeCode.ts";
import type { ConnectorsView } from "./useConnectors.ts";
import type { NotificationsView } from "./useNotifications.ts";
import type { RulesView } from "./useRules.ts";
import type { SignInView } from "./useSignIn.ts";
import { type VoiceControl, VoiceSection } from "./VoiceSection.tsx";
import "./settings.css";

export type { SettingsSection } from "./sections.ts";

// Changes save on their own once edits pause this long, so a typed amount saves once.
export const AUTOSAVE_MS = 500;

export type CatalogState = "loading" | "ready" | "empty" | "stale" | "refreshing" | "offline";

export interface SettingsSheetProps {
  remoteApi?: ApiClient;
  open: boolean;
  // Where to go, and a count that changes with each request, so asking again still goes there.
  // With no section, a phone shows the list of sections and a wide screen starts at the top.
  section?: SettingsSection;
  sectionRequest?: number;
  // The id of what to bring into view and light up there, such as Keys' unlock form.
  tip?: string;
  appearance?: AppearanceControl;
  showDot?: ShowDotControl;
  // Which dot works the next task, and whether Auto picks it for each new conversation.
  persona?: {
    value: PersonaId;
    onChange(value: PersonaId): void;
    auto: { on: boolean; onChange(on: boolean): void; disabledReason?: string };
  };
  // What tells this localDot apart from the user's others: its name and its dot's accessory.
  look?: {
    name: string;
    accessory?: Accessory;
    others: readonly LocalDotLink[];
    problem?: string;
    onName(value: string): void;
    onAccessory(value: Accessory | undefined): void;
    onOthers(value: LocalDotLink[]): void;
  };
  voice?: VoiceControl;
  // How this browser's live view gives way when the connection or the device slows.
  stream?: StreamPreferenceControl;
  choices: Partial<Record<ModelRole, RoleChoice>>;
  providers: readonly ProviderModels[];
  keys: readonly PickerKey[];
  keyLayer: "online" | "offline" | "unknown";
  subscriptionModels?: readonly SubscriptionModel[];
  chatgpt?: ChatgptControls;
  claudeCode?: ClaudeCodeControls;
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
  // Run on its own after an edit; settles once the save has.
  save?: { enabled: boolean; run(): Promise<void> | void };
  autonomy?: AutonomyPolicy;
  savedAutonomy?: AutonomyPolicy;
  onAutonomy?(value: AutonomyPolicy): void;
  rules?: RulesView;
  manualPrices?: Partial<Record<ModelRole, { input: string; output: string }>>;
  onPrice?(role: ModelRole, value: { input: string; output: string }): void;
  spending?: { value: SpendingDraft; change(next: SpendingDraft): void };
  // What the current task and today have cost, as keyd counts it.
  spent?: { taskUSD: number; dayUSD: number; estimated: boolean } | null;
  checkIns?: {
    value: CheckInsDraft;
    change(key: CheckInKey, next: CheckInsDraft[CheckInKey]): void;
  };
  research?: { value: ResearchDraft; change(next: ResearchDraft): void };
  purposeCheck?: PurposeCheckControl;
  knowledge?: Knowledge;
  known?: WhatDotKnows;
  recentActivity?: RecentActivityControl;
  // Opens an earlier task's replay, from where a fact or a person came from.
  onOpenTask?(sessionId: string): void;
  notifications?: NotificationsView;
  accounts?: AccountsView;
  browser?: BrowserStatusView;
  // Sign in to a site: the web browser opens it with the user in control.
  signIn?: SignInView;
  // The user's connected apps and their tools.
  connectors?: ConnectorsView;
  keysPanel?: Omit<KeysPanelProps, "active" | "onHolding" | "reveal">;
  // Shut down, and on a phone, where the sheet covers the island, the task's Stop.
  stop?: { label: string; enabled: boolean; run(): void; task?: boolean };
  // A new version of the computer, while one is ready or going on.
  update?: ComputerUpdate;
  appUpdate?: AppUpdateControl;
  // Erases the computer and starts a clean one, unless dot is at work or the user holds it.
  freshStart?: FreshStart & { waitReason?: string };
  // On a phone, how the task's Stop went, which stays after Stop itself has gone; it drops from
  // the island on a wider screen.
  stopNote?: StopNote;
  // Opens first-run setup again, from its first choice.
  onSetup?(): void;
  // Stops every task, pauses every routine and freezes every computer.
  stopAll?: { run(): void; running: boolean };
  // Whether localDot starts when the user logs in to the Mac; undefined until known.
  startAtLogin?: { state: StartAtLoginState | undefined; busy: boolean; set(on: boolean): void };
  // The dots on this computer, which Your computer lists, adds to and removes from.
  dots?: LocalDots;
  // Report a problem, and what a failure card asked to report.
  report?: ReportControl;
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

// Scrolls only the sheet's body: scrollIntoView would also scroll the clipped panel around it and
// lift the sheet's header out of place.
function bringToTop(element: HTMLElement, smooth = false) {
  const body = element.closest<HTMLElement>(".ui-sheet-body");
  if (!body) return;
  const margin = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
  const top =
    body.scrollTop +
    element.getBoundingClientRect().top -
    body.getBoundingClientRect().top -
    margin;
  if (smooth && !matches(REDUCED_MOTION) && typeof body.scrollTo === "function")
    body.scrollTo({ top, behavior: "smooth" });
  else body.scrollTop = top;
}

// Wholly inside the sheet body's visible part.
function inView(element: HTMLElement): boolean {
  const body = element.closest<HTMLElement>(".ui-sheet-body")?.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  return !!body && box.top >= body.top && box.bottom <= body.bottom;
}

function Section({
  id,
  title,
  heading = true,
  hidden = false,
  aside,
  children,
}: {
  id: SettingsSection;
  title: string;
  heading?: boolean;
  hidden?: boolean;
  // One action at the heading's end.
  aside?: ReactNode;
  children: ReactNode;
}) {
  const h3 = (
    <h3 id={`settings-${id}-title`} className="settings-section-title" tabIndex={-1}>
      {title}
    </h3>
  );
  return (
    <section
      id={`settings-${id}`}
      hidden={hidden}
      className="settings-section"
      data-section={id}
      aria-labelledby={heading ? `settings-${id}-title` : undefined}
      aria-label={heading ? undefined : title}
    >
      {heading &&
        (aside ? (
          <div className="settings-section-head">
            {h3}
            {aside}
          </div>
        ) : (
          h3
        ))}
      {children}
    </section>
  );
}

export function SettingsSheet(props: SettingsSheetProps) {
  const phone = useMediaQuery(PHONE);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [holding, setHolding] = useState(false);
  const [doneBlocked, setDoneBlocked] = useState(false);
  // The sidebar mounts before the body. Publish the node so its navigation runs only once the
  // scroller exists, including a fresh opening with already-cached settings.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const runSave = useRef(() => {});
  runSave.current = () => {
    if (!props.save?.enabled) return;
    setSaving(true);
    void Promise.resolve(props.save.run()).finally(() => setSaving(false));
  };

  // A phone shows one section at a time over the list of them; Back pops to the one before.
  const [stack, setStack] = useState<SettingsSection[]>([]);
  const [request, setRequest] = useState<{ open: boolean; at?: number }>({ open: false });
  if (props.open !== request.open || (props.open && props.sectionRequest !== request.at)) {
    const fresh = !request.open;
    setRequest({ open: props.open, at: props.sectionRequest });
    if (props.open) {
      const want = props.section;
      setStack((now) => {
        const from = fresh ? [] : now;
        if (!want) return fresh ? [] : now;
        const at = from.indexOf(want);
        return at >= 0 ? from.slice(0, at + 1) : [...from, want];
      });
    }
  }
  const page = stack.at(-1);
  const selected = page ?? shownSections(props, phone)[0] ?? "models";
  // Retain visited forms, but only the selected section participates in layout.
  const [visited, setVisited] = useState<SettingsSection[]>([]);
  const mountedSections = [...new Set([...visited, selected])];
  useLayoutEffect(() => {
    if (!props.open) return;
    setVisited((before) => (before.includes(selected) ? before : [...before, selected]));
    const scroll = body?.closest<HTMLElement>(".ui-sheet-body");
    if (scroll) scroll.scrollTop = 0;
  }, [selected, body, props.open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only explicit open/navigation requests move focus; sidebar selection retains its own focus
  useLayoutEffect(() => {
    if (props.open && !phone)
      body
        ?.querySelector<HTMLElement>(`#settings-${selected}-title`)
        ?.focus({ preventScroll: true });
  }, [props.open, props.sectionRequest, body, phone]);
  // A tip may show after its section does (Keys' unlock form waits for key protection to answer),
  // so it is looked for after each render until it is there.
  const tipWanted = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each request looks for its tip again
  useLayoutEffect(() => {
    tipWanted.current = props.open ? (props.tip ?? null) : null;
  }, [props.open, props.sectionRequest, props.tip]);
  useLayoutEffect(() => {
    const id = tipWanted.current;
    const target = id ? body?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) : null;
    if (!target || target.closest("[hidden]")) return;
    tipWanted.current = null;
    target.removeAttribute("data-tip");
    // Read the layout so a tip lit again starts its light again.
    target.getBoundingClientRect();
    target.setAttribute("data-tip", "");
    if (!inView(target)) bringToTop(target, true);
    target.addEventListener("animationend", () => target.removeAttribute("data-tip"), {
      once: true,
    });
    if (!matches(TOUCH))
      target.querySelector<HTMLElement>("input, textarea")?.focus({ preventScroll: true });
  });
  const [revealIssue, setRevealIssue] = useState(0);
  useLayoutEffect(() => {
    if (!revealIssue || !body) return;
    const section = body.querySelector<HTMLElement>(`#settings-${selected}`);
    const target =
      section?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      section?.querySelector<HTMLElement>(
        '.keys-secret input, input.keys-secret, textarea.keys-secret, input[type="password"]',
      ) ??
      section?.querySelector<HTMLElement>('input, [role="combobox"], [role="alert"]');
    if (target) {
      bringToTop(target);
      target.focus({ preventScroll: true });
    }
  }, [revealIssue, selected, body]);
  const revealUnfinished = () => {
    const text = props.validation?.join(" ").toLowerCase() ?? "";
    const target: SettingsSection = holding
      ? "keys"
      : /budget|spend|price/.test(text)
        ? "spending"
        : /check.in|research/.test(text)
          ? "autonomy"
          : "models";
    setStack([target]);
    setRevealIssue((n) => n + 1);
    setDoneBlocked(true);
  };

  const edits = JSON.stringify([
    props.choices,
    props.autonomy,
    props.spending?.value,
    props.checkIns?.value,
    props.research?.value,
    props.manualPrices,
    props.purposeCheck?.on,
    props.recentActivity?.on,
  ]);
  const canSave = !!props.save?.enabled && !props.error;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each edit starts the wait again
  useEffect(() => {
    if (!props.open || !props.dirty || !canSave || saving || props.busy || leaving) return;
    const timer = window.setTimeout(() => runSave.current(), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [props.open, props.dirty, canSave, saving, props.busy, leaving, edits]);

  // Closing waits for a save; incomplete fields are revealed without dropping edits.
  const pending = props.dirty && (canSave || saving || props.busy);
  const done = () => {
    // Done is also an explicit retry after a confirmed failed save. Uncertain
    // saves keep save.enabled false until the saved state has been reloaded.
    if (!holding && props.dirty && props.error && props.save?.enabled && !saving && !props.busy) {
      setDoneBlocked(false);
      setLeaving(true);
      runSave.current();
      return;
    }
    if (holding || (props.dirty && !pending)) {
      revealUnfinished();
      return;
    }
    setDoneBlocked(false);
    close();
  };
  const close = () => {
    if (holding || (props.dirty && !pending)) {
      revealUnfinished();
      return;
    }
    if (pending || props.busy) setLeaving(true);
    else props.onClose();
  };
  useEffect(() => {
    if (!leaving) return;
    if (!props.open) return setLeaving(false);
    if (saving || props.busy) return;
    if (!props.dirty) {
      setLeaving(false);
      props.onClose();
    } else if (canSave) runSave.current();
    else setLeaving(false);
  }, [leaving, props.open, saving, props.busy, props.dirty, canSave, props.onClose]);

  const shown = shownSections(props, phone);
  const problems = props.dirty && props.validation?.length ? props.validation : null;
  const doneProblem = doneBlocked
    ? holding
      ? "Save or cancel the key you are editing before finishing."
      : props.dirty && !pending && !props.error && !problems
        ? "Your changes have not been saved yet. Wait for settings to finish loading, then try Done again."
        : null
    : null;
  const footer =
    !props.loading && (props.error || problems || doneProblem) ? (
      <div className="settings-footer">
        {props.error || doneProblem ? (
          <p className="settings-footer-status" role="alert" data-error="">
            <Icon name="circle-alert" size={12} />
            {props.error || doneProblem}
          </p>
        ) : (
          <div className="settings-footer-status" role="alert" data-error="">
            <span>Before this can be saved:</span>
            <ul className="settings-problems">
              {problems?.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
        {props.dirty && props.onReload && (
          <Revert
            disabledReason={props.busy ? "Wait for saving to finish" : undefined}
            onRevert={props.onReload}
          />
        )}
      </div>
    ) : (
      <div className="settings-footer">
        <p className="settings-footer-status" role="status">
          {props.loading
            ? "Loading settings…"
            : saving || props.busy || pending
              ? "Saving changes…"
              : "Changes save automatically."}
        </p>
      </div>
    );

  const keysPanel = props.keysPanel && (
    <KeysPanel
      {...props.keysPanel}
      active={props.open}
      onHolding={setHolding}
      reveal={(element) => bringToTop(element)}
    />
  );
  const content = (id: SettingsSection) => (
    <SectionContent id={id} props={props} keysPanel={keysPanel} />
  );

  if (phone)
    return (
      <Sheet
        open={props.open}
        onClose={close}
        onDone={done}
        dirty={holding || (props.dirty && !pending)}
        onDismissAttempt={close}
        title={page ? sectionTitle(page) : "Settings"}
        page={page ?? "root"}
        back={
          page
            ? {
                label:
                  stack.length > 1 ? sectionTitle(stack.at(-2) as SettingsSection) : "Settings",
                onBack: () => {
                  if (holding) {
                    revealUnfinished();
                    return;
                  }
                  setStack((now) => now.slice(0, -1));
                },
              }
            : undefined
        }
        doneLabel="Done"
        detents={["large"]}
        closeLabel="Close settings"
        className="settings-sheet"
        footer={footer}
      >
        <div
          ref={setBody}
          id="settings-sheet-body"
          className="settings-body"
          data-page={page ?? "root"}
        >
          {page ? (
            <Section id={page} title={sectionTitle(page)} heading={false}>
              {content(page)}
            </Section>
          ) : (
            <SectionList
              props={props}
              shown={shown}
              onOpen={(id) => setStack((now) => [...now, id])}
            />
          )}
        </div>
      </Sheet>
    );

  return (
    <Sheet
      open={props.open}
      onClose={close}
      dirty={holding || (props.dirty && !pending)}
      onDismissAttempt={close}
      modal
      title="Settings"
      closeLabel="Close settings"
      className="settings-sheet"
      sidebar={<SectionIndex shown={shown} current={selected} onSelect={(id) => setStack([id])} />}
      footer={footer}
    >
      <div ref={setBody} id="settings-sheet-body" className="settings-body">
        {mountedSections
          .filter((id) => shown.includes(id))
          .map((id) => (
            <Section
              key={id}
              hidden={id !== selected}
              id={id}
              title={sectionTitle(id)}
              aside={
                id === "computer" && props.stop && <ShutDown stop={props.stop} props={props} />
              }
            >
              {content(id)}
            </Section>
          ))}
      </div>
    </Sheet>
  );
}

function shownSections(props: SettingsSheetProps, phone = false): SettingsSection[] {
  const planMain = subscription(props.choices.main?.provider);
  const has: Record<SettingsSection, boolean> = {
    dot: !!props.persona,
    models: true,
    autonomy: !!props.onAutonomy,
    rules: !!props.rules,
    spending: !!props.spending && !planMain,
    appearance: !!props.appearance,
    voice: !!props.voice,
    notifications: !!props.notifications,
    knowledge: !!props.knowledge && !!props.known,
    accounts: !!props.accounts,
    connectors: !!props.connectors,
    keys: !!props.keysPanel,
    computer:
      (!!props.stop && !(phone && props.stop.task)) ||
      !!props.update?.available ||
      !!props.appUpdate ||
      !!props.freshStart ||
      !!props.stream ||
      !!props.stopAll ||
      !!props.startAtLogin ||
      (!!props.dots && !!props.remoteApi),
    report: !!props.report,
  };
  return SECTIONS.filter((section) => has[section.id]).map((section) => section.id);
}

// Each tab is a separate page. No scroll spy or resize callback can move the reader.
function SectionIndex({
  shown,
  current,
  onSelect,
}: {
  shown: readonly SettingsSection[];
  current: SettingsSection;
  onSelect(id: SettingsSection): void;
}) {
  return (
    <nav className="settings-index" aria-label="Settings sections">
      {SECTIONS.filter((section) => shown.includes(section.id)).map((section) => (
        <SheetNavItem
          key={section.id}
          icon={section.icon}
          label={section.title}
          current={current === section.id}
          onSelect={() => onSelect(section.id)}
        />
      ))}
    </nav>
  );
}

// A phone's first page: each section as a row with what it holds now, the task's Stop and the
// computer above them all.
function SectionList({
  props,
  shown,
  onOpen,
}: {
  props: SettingsSheetProps;
  shown: readonly SettingsSection[];
  onOpen(id: SettingsSection): void;
}) {
  const main = props.choices.main;
  const mainName = main
    ? ((subscription(main.provider)
        ? props.subscriptionModels
        : props.providers.find((row) => row.id === main.provider)?.models
      )?.find((model) => model.id === main.model)?.name ?? main.model)
    : "";
  const values: Partial<Record<SettingsSection, string>> = {
    dot: props.persona ? personaOf(props.persona.value).name : "",
    models: props.loading ? "" : mainName,
    autonomy: props.loading ? "" : autonomyValue(props.autonomy),
    rules: countValue(props.rules?.rules.length),
    spending: props.loading ? "" : spendingValue(props.spending?.value, planOnly(props.choices)),
    appearance: APPEARANCE_NAMES[props.appearance?.value ?? "graphite"],
    voice: props.voice ? routeLabel(props.voice.route) : "",
    notifications: notificationsValue(props.notifications?.device),
    accounts: props.accounts?.phase === "ready" ? countValue(props.accounts.sites.length) : "",
    connectors:
      props.connectors?.phase === "ready" ? countValue(props.connectors.connectors.length) : "",
    keys: countValue(props.keysPanel?.keys.keys.length),
    computer:
      props.appUpdate?.status?.availableVersion || props.update?.available
        ? "Update available"
        : "",
  };
  const row = (id: SettingsSection) => {
    const section = SECTIONS.find((each) => each.id === id);
    if (!section || !shown.includes(id)) return null;
    return (
      <GroupRow
        key={id}
        leading={<IconTile icon={section.icon} />}
        label={section.title}
        trailing={values[id]}
        onSelect={() => onOpen(id)}
      />
    );
  };
  const task = props.stop?.task ? props.stop : undefined;
  return (
    <>
      {(task || props.stopNote || shown.includes("computer")) && (
        <Group>
          {(task || props.stopNote) && <TaskRow stop={task} note={props.stopNote} />}
          {row("computer")}
        </Group>
      )}
      <Group>{(["dot", "models", "autonomy", "rules"] as const).map(row)}</Group>
      <Group>
        {(
          [
            "spending",
            "appearance",
            "voice",
            "notifications",
            "knowledge",
            "accounts",
            "connectors",
            "keys",
          ] as const
        ).map(row)}
      </Group>
      {shown.includes("report") && <Group>{row("report")}</Group>}
    </>
  );
}

// On a phone, where the sheet covers the island: the task's Stop, then how the last Stop went, with
// any cleanup it couldn't confirm behind Details.
function TaskRow({ stop, note }: { stop?: SettingsSheetProps["stop"]; note?: StopNote }) {
  return (
    <GroupRow
      leading={<IconTile icon="stop" />}
      label="This task"
      detail={note && <span role="status">{note.line}</span>}
      trailing={
        stop && (
          <Button
            size="sm"
            disabledReason={stop.enabled ? undefined : "Not available right now"}
            onClick={() => stop.run()}
          >
            {stop.label}
          </Button>
        )
      }
    >
      {!!note?.details?.length && (
        <DetailLines lines={note.details} className="settings-stop-details" />
      )}
    </GroupRow>
  );
}

// Shut down sits at the computer's heading on a wide screen and ends its page on a phone.
function ShutDown({
  stop,
  props,
  wide = false,
}: {
  stop: NonNullable<SettingsSheetProps["stop"]>;
  props: SettingsSheetProps;
  wide?: boolean;
}) {
  return (
    <Button
      size={wide ? "xl" : "sm"}
      icon="power"
      className={wide ? "settings-wide" : undefined}
      disabledReason={stop.enabled && !props.update?.busy ? undefined : "Not available right now"}
      onClick={() => stop.run()}
    >
      {stop.label}
    </Button>
  );
}

const STREAM_CHOICES = [
  { value: "auto", label: "Auto" },
  { value: "sharp", label: "Sharp" },
  { value: "smooth", label: "Smooth" },
] as const;

function StreamChoice({
  stream,
  size,
  className,
}: {
  stream: StreamPreferenceControl;
  size: 24 | 32;
  className?: string;
}) {
  return (
    <SegmentedControl
      size={size}
      className={className}
      aria-label="Stream quality"
      value={stream.value}
      items={STREAM_CHOICES}
      onValueChange={(next) => {
        const choice = STREAM_PREFERENCES.find((each) => each === next);
        if (choice) stream.change(choice);
      }}
    />
  );
}

export interface StopNote {
  line: string;
  details?: readonly string[];
}

// The computer's settings, then what acts on all of it: Stop everything, and Start fresh last
// because it erases. On a phone, Shut down ends the page; a wide screen has it at the heading.
function ComputerControls({ props }: { props: SettingsSheetProps }) {
  const { stream, freshStart, stopAll, startAtLogin: login } = props;
  const update = props.update?.available ? props.update : undefined;
  const phone = useMediaQuery(PHONE);
  const shutDown = phone && props.stop && !props.stop.task ? props.stop : undefined;
  return (
    <>
      {props.appUpdate && <AppUpdateSettings update={props.appUpdate} />}
      {update && (
        <div>
          <GroupHead title="Computer updates" />
          <Group>
            <UpdateRow update={update} />
          </Group>
        </div>
      )}
      {props.remoteApi && <AccessLinksSettings api={props.remoteApi} />}
      {props.remoteApi && <RemoteAccessSettings api={props.remoteApi} />}
      {props.remoteApi && <RecordingStorageSettings api={props.remoteApi} />}
      {props.remoteApi && props.dots && (
        <DotsOnThisComputer api={props.remoteApi} dots={props.dots} />
      )}
      {(login || stream) && (
        <div>
          <Group>
            {login && (
              <Switch
                className="ui-group-row"
                leading={<IconTile icon="repeat" />}
                label="Open at login"
                description={
                  login.state === "unavailable"
                    ? undefined
                    : "Start localDot when you sign in to this computer"
                }
                checked={login.state === "on"}
                disabledReason={
                  login.state === "unavailable"
                    ? "Rerun the localDot installer on this computer to enable startup settings."
                    : login.state === undefined
                      ? "Checking…"
                      : login.busy
                        ? "Saving…"
                        : undefined
                }
                onCheckedChange={(on) => login.set(on)}
              />
            )}
            {stream && (
              <GroupRow
                leading={<IconTile icon="monitor" />}
                label="Stream quality"
                trailing={phone ? undefined : <StreamChoice stream={stream} size={24} />}
              >
                {phone && (
                  <StreamChoice stream={stream} size={32} className="settings-stream-choice" />
                )}
              </GroupRow>
            )}
          </Group>
          {stream && (
            <GroupNote>
              {stream.saved
                ? "Auto picks for you. When things slow down, Sharp keeps text crisp and Smooth keeps motion fluid."
                : "Applied for this visit. This browser couldn't save it."}
            </GroupNote>
          )}
        </div>
      )}
      {(stopAll || freshStart) && (
        <Group>
          {stopAll && (
            <GroupRow
              leading={<IconTile icon="stop" />}
              label="Stop everything"
              detail="Stops every task, pauses routines and freezes your computer."
              trailing={
                <Button
                  size="sm"
                  busy={stopAll.running}
                  aria-label="Stop everything"
                  onClick={() => stopAll.run()}
                >
                  Stop
                </Button>
              }
            />
          )}
          {freshStart && <FreshStartRow freshStart={freshStart} />}
        </Group>
      )}
      {shutDown && <ShutDown stop={shutDown} props={props} wide />}
    </>
  );
}

function UpdateRow({ update }: { update: ComputerUpdate }) {
  return (
    <GroupRow
      leading={<IconTile icon="download" />}
      label={
        <span className="settings-update-label" role="status">
          <span data-shown={update.busy ? undefined : ""}>New version ready</span>
          <span data-shown={update.busy ? "" : undefined}>Updating…</span>
        </span>
      }
      detail={
        update.error && !update.busy ? (
          <span className="settings-computer-error">{update.error}</span>
        ) : (
          "Updates the computer environment. Your files and sign-ins are kept."
        )
      }
      trailing={
        <Button
          size="sm"
          variant="primary"
          busy={update.busy}
          disabledReason={update.busy ? undefined : update.waitReason}
          onClick={update.run}
        >
          Update
        </Button>
      }
    />
  );
}

function FreshStartRow({
  freshStart,
}: {
  freshStart: NonNullable<SettingsSheetProps["freshStart"]>;
}) {
  return (
    <GroupRow
      leading={<IconTile icon="history" />}
      label="Start fresh"
      detail={
        freshStart.error && !freshStart.busy ? (
          <span className="settings-computer-error">{freshStart.error}</span>
        ) : (
          "Erases your computer's files. Your sign\u2011ins stay."
        )
      }
      trailing={
        <FreshStartButton
          size="sm"
          variant="destructive"
          busy={freshStart.busy}
          disabledReason={freshStart.busy ? undefined : freshStart.waitReason}
          run={freshStart.run}
        >
          Erase…
        </FreshStartButton>
      }
    />
  );
}

// The name and accessory that tell this localDot apart, as every device that opens it shows them.
function ThisLocalDot({
  look,
  persona,
}: {
  look: NonNullable<SettingsSheetProps["look"]>;
  persona: PersonaId;
}) {
  return (
    <div>
      <GroupHead title="This localDot" />
      <Group>
        <Field label="Name" inline className="ui-group-row" error={look.problem}>
          <TextField
            size="sm"
            value={look.name}
            maxLength={40}
            placeholder="Studio Mac"
            autoComplete="off"
            onChange={(event) => look.onName(event.target.value)}
          />
        </Field>
      </Group>
      <GroupNote>A name and an accessory tell this localDot apart from your others.</GroupNote>
      <div className="settings-accessories">
        <AccessoryPicker persona={persona} value={look.accessory} onChange={look.onAccessory} />
      </div>
      <OtherLocalDots links={look.others} onChange={look.onOthers} />
    </div>
  );
}

function SectionContent({
  id,
  props,
  keysPanel,
}: {
  id: SettingsSection;
  props: SettingsSheetProps;
  keysPanel: ReactNode;
}) {
  const wait = (height: number) => (
    <Skeleton loading shape="block" width="100%" height={`${height}px`} />
  );
  switch (id) {
    case "models": {
      if (props.loading)
        return <DotLoader className="settings-loading" label="Loading your settings" />;
      const main = props.choices.main?.provider;
      // A plan's own app runs only its own models: no local model beside either, and the ChatGPT
      // plan's app can't answer a fast model while a task holds it.
      const inactive = (role: ModelRole) =>
        (role === "local" || role === "fast") && main === CHATGPT
          ? "Off while the main model uses the ChatGPT plan."
          : role === "local" && main === CLAUDE_CODE
            ? "Off while the main model uses Claude Code."
            : undefined;
      return (
        <>
          {main === CHATGPT && props.chatgpt && (
            <ChatgptPanel id="models-chatgpt" account={props.chatgpt} />
          )}
          {main === CLAUDE_CODE && props.claudeCode && (
            <ClaudeCodePanel id="models-claude-code" claude={props.claudeCode} />
          )}
          {(["main", "fast", "local"] as const).map((role) => (
            <RoleCard
              key={role}
              modelRole={role}
              // A choice that waits beside this main model shows as off until it works again.
              value={
                roleActive(role, props.choices) || inactive(role) ? props.choices[role] : undefined
              }
              providers={props.providers}
              keys={props.keys}
              keyLayer={props.keyLayer}
              subscriptionModels={props.subscriptionModels}
              main={main}
              inactive={inactive(role)}
              manualPrice={props.manualPrices?.[role]}
              onChange={(value) => props.onChange(role, value)}
              onKeys={props.onKeys}
              onPrice={(value) => props.onPrice?.(role, value)}
            />
          ))}
          <div className="settings-inline settings-note-line">
            <p className="settings-lede" role="status">
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
          {props.onSetup && (
            <Group>
              <GroupRow
                leading={<IconTile icon="continue" />}
                label="Set up step by step"
                detail="How dot thinks, its model and permissions"
                onSelect={() => props.onSetup?.()}
              />
            </Group>
          )}
        </>
      );
    }
    case "autonomy":
      if (props.loading || !props.autonomy || !props.onAutonomy) return wait(220);
      return (
        <>
          <p className="settings-lede">
            How often dot stops to ask. Routine work on its own computer always just runs.
          </p>
          <AutonomyMatrix
            value={props.autonomy}
            saved={props.savedAutonomy}
            onChange={props.onAutonomy}
          />
          {props.purposeCheck && <PurposeCheck control={props.purposeCheck} />}
          {props.checkIns && (
            <CheckIns value={props.checkIns.value} onChange={props.checkIns.change} />
          )}
          {props.research && (
            <ResearchLimits value={props.research.value} onChange={props.research.change} />
          )}
        </>
      );
    case "rules":
      return props.rules ? <AlwaysAllowed rules={props.rules} /> : null;
    case "spending":
      if (props.loading || !props.spending) return wait(120);
      return (
        <>
          <p className="settings-lede">dot never stops for cost unless you set a limit.</p>
          {planOnly(props.choices) ? (
            <Group>
              <GroupRow
                label="Spending limit"
                detail="Your plan's own limits apply, so no limit is needed."
              />
            </Group>
          ) : (
            <SpendingLimits value={props.spending.value} onChange={props.spending.change} />
          )}
          {props.spent && (
            <div>
              <GroupHead
                title="So far"
                aside={props.spent.estimated ? "≈ means estimated" : undefined}
              />
              <Group>
                <GroupRow
                  label="This task"
                  trailing={spendText(props.spent.taskUSD, props.spent.estimated)}
                />
                <GroupRow
                  label="Today"
                  trailing={spendText(props.spent.dayUSD, props.spent.estimated)}
                />
              </Group>
              <GroupNote>
                Spend also shows in Activity and in each conversation's summary. It never interrupts
                you.
              </GroupNote>
            </div>
          )}
        </>
      );
    case "dot":
      if (props.loading || !props.persona) return wait(220);
      return (
        <>
          <p className="settings-lede">
            Each dot brings the skills and habits for one kind of work, so a task carries only what
            it needs. Your choice applies from the next task.
          </p>
          <Group>
            <AutoDot className="ui-group-row" {...props.persona.auto} />
          </Group>
          <PersonaPicker
            value={props.persona.value}
            onChange={props.persona.onChange}
            aria-label={props.persona.auto.on ? "When Auto can't pick" : "Your dot"}
          />
          {props.look && <ThisLocalDot look={props.look} persona={props.persona.value} />}
        </>
      );
    case "appearance":
      return props.appearance ? (
        <Appearance appearance={props.appearance} showDot={props.showDot} />
      ) : null;
    case "voice":
      return props.voice ? <VoiceSection voice={props.voice} /> : null;
    case "notifications":
      return props.notifications ? <NotificationsSection view={props.notifications} /> : null;
    case "knowledge":
      return props.knowledge && props.known ? (
        <KnowledgeSection
          knowledge={props.knowledge}
          known={props.known}
          recentActivity={props.recentActivity}
          onOpenTask={props.onOpenTask}
        />
      ) : null;
    case "accounts":
      return props.accounts ? (
        <AccountsSection
          accounts={props.accounts}
          signIn={props.signIn}
          browser={props.browser}
          report={props.report}
        />
      ) : null;
    case "connectors":
      return props.connectors ? <ConnectorsSection connectors={props.connectors} /> : null;
    case "keys":
      return keysPanel;
    case "computer":
      return <ComputerControls props={props} />;
    case "report":
      return props.report ? <ReportProblem report={props.report} /> : null;
  }
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

function Appearance({
  appearance,
  showDot,
}: {
  appearance: AppearanceControl;
  showDot?: ShowDotControl;
}) {
  return (
    <>
      <div>
        <AppearancePicker appearance={appearance} aria-label="Theme" />
        {appearance.value === "system" && (
          <GroupNote>
            Daylight while this device is light, {APPEARANCE_NAMES[appearance.dark]} while it's
            dark.
          </GroupNote>
        )}
        {!appearance.saved && (
          <GroupNote>Applied for this visit. This browser couldn't save it.</GroupNote>
        )}
      </div>
      {showDot && (
        <div>
          <Group>
            <Switch
              className="ui-group-row"
              label="Show dot"
              description="dot's face on the curtain and beside the computer"
              checked={showDot.value}
              onCheckedChange={(checked) => showDot.change(checked)}
            />
          </Group>
          {!showDot.saved && (
            <GroupNote>Applied for this visit. This browser couldn't save it.</GroupNote>
          )}
        </div>
      )}
    </>
  );
}
