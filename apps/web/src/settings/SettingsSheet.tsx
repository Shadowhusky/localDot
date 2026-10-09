import type { AutonomyPolicy } from "@localdot/protocol";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Knowledge } from "../agent/useKnowledge.ts";
import { type ComputerUpdate, UPDATE_READY } from "../cells/useComputerUpdate.ts";
import { spendText } from "../copy/format.ts";
import { DotLoader } from "../dot/DotLoader.tsx";
import type { ShowDotControl } from "../dot/show-dot.ts";
import { KeysPanel, type KeysPanelProps } from "../keys/KeysPanel.tsx";
import { type AppearanceControl, AppearancePicker } from "../onboarding/AppearancePicker.tsx";
import { Button } from "../ui/Button.tsx";
import { Group, GroupHead, GroupNote, GroupRow, IconTile } from "../ui/Group.tsx";
import { Icon } from "../ui/Icon.tsx";
import { matches, PHONE, REDUCED_MOTION, useMediaQuery } from "../ui/media.ts";
import { Sheet, SheetNavItem, useConfirmDiscard } from "../ui/Sheet.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { Switch } from "../ui/Switch.tsx";
import { AccountsSection } from "./AccountsSection.tsx";
import { AlwaysAllowed, AutonomyMatrix } from "./AutonomyMatrix.tsx";
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
import { CheckIns, SpendingLimits } from "./Limits.tsx";
import { RoleCard } from "./RoleCard.tsx";
import {
  autonomyValue,
  countValue,
  SECTIONS,
  type SettingsSection,
  sectionInView,
  sectionTitle,
  spendingValue,
} from "./sections.ts";
import type { CheckInKey, CheckInsDraft, SpendingDraft } from "./settings-form.ts";
import type { AccountsView } from "./useAccounts.ts";
import type { ChatgptControls } from "./useChatgpt.ts";
import type { RulesView } from "./useRules.ts";
import "./settings.css";

export type { SettingsSection } from "./sections.ts";

// Changes save on their own once edits pause this long, so a typed amount saves once.
export const AUTOSAVE_MS = 500;

export type CatalogState = "loading" | "ready" | "empty" | "stale" | "refreshing" | "offline";

export interface SettingsSheetProps {
  open: boolean;
  // Where to go, and a count that changes with each request, so asking again still goes there.
  // With no section, a phone shows the list of sections and a wide screen starts at the top.
  section?: SettingsSection;
  sectionRequest?: number;
  appearance?: AppearanceControl;
  showDot?: ShowDotControl;
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
  knowledge?: Knowledge;
  accounts?: AccountsView;
  keysPanel?: Omit<KeysPanelProps, "active" | "onHolding" | "reveal">;
  // Shut down, and on a phone, where the sheet covers the island, the task's Stop.
  stop?: { label: string; enabled: boolean; run(): void };
  // A new version of the computer, while one is ready or going on.
  update?: ComputerUpdate;
  // On a phone, what Stop reports, which stays after Stop itself has gone; the island says it
  // on a wider screen.
  taskControls?: ReactNode;
  // Opens first-run setup again, from its first choice.
  onSetup?(): void;
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

function Section({
  id,
  title,
  heading = true,
  children,
}: {
  id: SettingsSection;
  title: string;
  heading?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={`settings-${id}`}
      className="settings-section"
      data-section={id}
      aria-labelledby={heading ? `settings-${id}-title` : undefined}
      aria-label={heading ? undefined : title}
    >
      {heading && (
        <h3 id={`settings-${id}-title`} className="settings-section-title" tabIndex={-1}>
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}

export function SettingsSheet(props: SettingsSheetProps) {
  const phone = useMediaQuery(PHONE);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [holding, setHolding] = useState(false);
  const body = useRef<HTMLDivElement>(null);
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

  const edits = JSON.stringify([
    props.choices,
    props.autonomy,
    props.spending?.value,
    props.checkIns?.value,
    props.manualPrices,
  ]);
  const canSave = !!props.save?.enabled && !props.error;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each edit starts the wait again
  useEffect(() => {
    if (!props.open || !props.dirty || !canSave || saving || props.busy || leaving) return;
    const timer = window.setTimeout(() => runSave.current(), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [props.open, props.dirty, canSave, saving, props.busy, leaving, edits]);

  // Closing waits for an edit on its way to be saved; only edits that can't be saved ask first.
  const pending = props.dirty && (canSave || saving);
  const close = () => {
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

  // Once the saved settings are in, focus goes to the main model's provider, or to the requested
  // section, unless the person has already moved it from where the sheet put it on opening.
  const placed = useRef<Element | null | undefined>(undefined);
  useEffect(() => {
    if (!props.open) {
      placed.current = undefined;
      return;
    }
    const sheet = body.current?.closest<HTMLElement>("[role=dialog]");
    if (!sheet) return;
    if (placed.current === undefined) placed.current = document.activeElement;
    if (props.loading || placed.current === null) return;
    const now = document.activeElement;
    const moved = now !== placed.current && now !== sheet && sheet.contains(now);
    placed.current = null;
    if (moved || phone) return;
    const section = props.section;
    if (section && section !== "models") {
      const target = sheet.querySelector<HTMLElement>(`#settings-${section}`);
      const control =
        section === "spending"
          ? target?.querySelector<HTMLElement>("[role=switch]")
          : section === "autonomy"
            ? target?.querySelector<HTMLElement>("input[type=radio]:checked")
            : target?.querySelector<HTMLElement>(`#settings-${section}-title`);
      control?.focus({ preventScroll: true });
    } else if (!matches("(pointer: coarse)")) {
      sheet.querySelector<HTMLElement>("[data-role=main] [role=combobox]")?.focus();
    }
  }, [props.open, props.loading, props.section, phone]);

  const shown = shownSections(props);
  const problems = props.dirty && props.validation?.length ? props.validation : null;
  const footer =
    !props.loading && (props.error || problems) ? (
      <div className="settings-footer">
        {props.error ? (
          <p className="settings-footer-status" role="alert" data-error="">
            <Icon name="circle-alert" size={12} />
            {props.error}
          </p>
        ) : (
          <div className="settings-footer-status" role="status">
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
    ) : undefined;

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
        dirty={holding || (props.dirty && !pending)}
        title={page ? sectionTitle(page) : "Settings"}
        page={page ?? "root"}
        back={
          page
            ? {
                label:
                  stack.length > 1 ? sectionTitle(stack.at(-2) as SettingsSection) : "Settings",
                onBack: () => setStack((now) => now.slice(0, -1)),
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
          ref={body}
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
      modal
      title="Settings"
      closeLabel="Close settings"
      className="settings-sheet"
      sidebar={<SectionIndex shown={shown} body={body} request={props} />}
      footer={footer}
    >
      <div ref={body} id="settings-sheet-body" className="settings-body">
        {shown.map((id) => (
          <Section key={id} id={id} title={sectionTitle(id)}>
            {content(id)}
          </Section>
        ))}
      </div>
    </Sheet>
  );
}

function shownSections(props: SettingsSheetProps): SettingsSection[] {
  const chatgptMain = props.choices.main?.provider === CHATGPT;
  const has: Record<SettingsSection, boolean> = {
    models: true,
    autonomy: !!props.onAutonomy,
    rules: !!props.rules,
    spending: !!props.spending && !chatgptMain,
    appearance: !!props.appearance,
    knowledge: !!props.knowledge,
    accounts: !!props.accounts,
    keys: !!props.keysPanel,
    computer: !!props.stop || !!props.update?.available,
  };
  return SECTIONS.filter((section) => has[section.id]).map((section) => section.id);
}

// The sidebar: a row per section, lit for the one being read, and a press scrolls to it.
function SectionIndex({
  shown,
  body,
  request,
}: {
  shown: readonly SettingsSection[];
  body: { current: HTMLDivElement | null };
  request: Pick<SettingsSheetProps, "open" | "section" | "sectionRequest" | "loading">;
}) {
  const [current, setCurrent] = useState<SettingsSection>(request.section ?? "models");
  // A press holds its section lit while the scroll it started runs, until the reader scrolls.
  const pinned = useRef<SettingsSection | null>(null);
  const scroller = useCallback(
    () => body.current?.closest<HTMLElement>(".ui-sheet-body") ?? null,
    [body],
  );
  const go = useCallback(
    (id: SettingsSection, smooth: boolean) => {
      const target = body.current?.querySelector<HTMLElement>(`#settings-${id}`);
      pinned.current = id;
      setCurrent(id);
      if (target) bringToTop(target, smooth);
    },
    [body],
  );

  const asked = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!request.open) {
      asked.current = undefined;
      return;
    }
    // Keys never waits for the saved settings, which may still move it once they arrive.
    if (request.loading) {
      if (request.section === "keys") go("keys", false);
      return;
    }
    if (asked.current === request.sectionRequest && asked.current !== undefined) return;
    const opening = asked.current === undefined;
    asked.current = request.sectionRequest ?? 0;
    if (request.section) go(request.section, !opening);
  }, [request.open, request.loading, request.section, request.sectionRequest, go]);

  useEffect(() => {
    const element = scroller();
    if (!element) return;
    const spy = () => {
      if (pinned.current) return;
      const origin = element.getBoundingClientRect().top - element.scrollTop;
      const tops = [...element.querySelectorAll<HTMLElement>("[data-section]")].map((section) => ({
        id: section.dataset.section as SettingsSection,
        top: section.getBoundingClientRect().top - origin,
      }));
      const seen = sectionInView(tops, {
        top: element.scrollTop,
        height: element.clientHeight,
        content: element.scrollHeight,
      });
      if (seen) setCurrent(seen);
    };
    const release = () => {
      pinned.current = null;
    };
    // Sections above the one gone to may still be filling in; it stays at the top until the reader
    // scrolls.
    const hold = () => {
      const target =
        pinned.current && body.current?.querySelector<HTMLElement>(`#settings-${pinned.current}`);
      if (target) bringToTop(target);
    };
    const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(hold);
    if (body.current) resized?.observe(body.current);
    element.addEventListener("scroll", spy, { passive: true });
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
      element.addEventListener(type, release, { passive: true });
    return () => {
      resized?.disconnect();
      element.removeEventListener("scroll", spy);
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"])
        element.removeEventListener(type, release);
    };
  }, [scroller, body]);

  return (
    <nav className="settings-index" aria-label="Settings sections">
      {SECTIONS.filter((section) => shown.includes(section.id)).map((section) => (
        <SheetNavItem
          key={section.id}
          icon={section.icon}
          label={section.title}
          current={current === section.id}
          onSelect={() => go(section.id, true)}
        />
      ))}
    </nav>
  );
}

// A phone's first page: each section as a row with what it holds now, Stop above them all.
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
    ? (props.providers
        .find((row) => row.id === main.provider)
        ?.models.find((model) => model.id === main.model)?.name ?? main.model)
    : "";
  const values: Partial<Record<SettingsSection, string>> = {
    models: props.loading ? "" : mainName,
    autonomy: props.loading ? "" : autonomyValue(props.autonomy),
    rules: countValue(props.rules?.rules.length),
    spending: props.loading ? "" : spendingValue(props.spending?.value, planOnly(props.choices)),
    appearance: props.appearance?.value === "midnight" ? "Midnight" : "Graphite",
    accounts: props.accounts?.phase === "ready" ? countValue(props.accounts.sites.length) : "",
    keys: countValue(props.keysPanel?.keys.keys.length),
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
  return (
    <>
      {(props.stop || props.taskControls || props.update?.available) && (
        <ComputerControls props={props} />
      )}
      <Group>{(["models", "autonomy", "rules"] as const).map(row)}</Group>
      <Group>
        {(["spending", "appearance", "knowledge", "accounts", "keys"] as const).map(row)}
      </Group>
    </>
  );
}

function ComputerControls({ props }: { props: SettingsSheetProps }) {
  const update = props.update?.available ? props.update : undefined;
  return (
    <div>
      {(props.stop || update) && (
        <Group>
          {props.stop && (
            <GroupRow
              leading={<IconTile icon="power" />}
              label="Your computer"
              trailing={
                <Button
                  size="sm"
                  icon="stop"
                  disabledReason={
                    props.stop.enabled && !update?.busy ? undefined : "Not available right now"
                  }
                  onClick={() => props.stop?.run()}
                >
                  {props.stop.label}
                </Button>
              }
            />
          )}
          {update && <UpdateRow update={update} />}
        </Group>
      )}
      {props.taskControls}
    </div>
  );
}

function UpdateRow({ update }: { update: ComputerUpdate }) {
  return (
    <GroupRow
      leading={<IconTile icon="download" />}
      label={
        <span className="settings-update-label" role="status">
          <span data-shown={update.busy ? undefined : ""}>{UPDATE_READY}</span>
          <span data-shown={update.busy ? "" : undefined}>Updating your computer…</span>
        </span>
      }
      detail={
        update.error && !update.busy ? (
          <span className="settings-update-error">{update.error}</span>
        ) : (
          "Your files and sign-ins stay. It restarts in about a minute."
        )
      }
      trailing={
        <Button size="sm" variant="primary" busy={update.busy} onClick={update.run}>
          Update
        </Button>
      }
    />
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
      const chatgptMain = props.choices.main?.provider === CHATGPT;
      return (
        <>
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
          <div className="settings-inline settings-catalog">
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
          {props.checkIns && (
            <CheckIns value={props.checkIns.value} onChange={props.checkIns.change} />
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
            </div>
          )}
          <GroupNote>
            Spend also shows in Activity's usage line and in each conversation's summary. It never
            interrupts you.
          </GroupNote>
        </>
      );
    case "appearance":
      return props.appearance ? (
        <Appearance appearance={props.appearance} showDot={props.showDot} />
      ) : null;
    case "knowledge":
      return props.knowledge ? <KnowledgeSection knowledge={props.knowledge} /> : null;
    case "accounts":
      return props.accounts ? <AccountsSection accounts={props.accounts} /> : null;
    case "keys":
      return keysPanel;
    case "computer":
      return <ComputerControls props={{ ...props, taskControls: undefined }} />;
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
