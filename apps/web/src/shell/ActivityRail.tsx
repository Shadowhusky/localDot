import type { TaskModelSelection } from "@localdot/protocol";
import type { KeyUseState, PlanItemState } from "@localdot/stage";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityDetail } from "../agent/ActivityDetails.tsx";
import { ActivityRow, reveal, revealOpened } from "../agent/ActivityRow.tsx";
import {
  type ActivityEntry,
  type ActivityFilter,
  activityRows,
  type EntryView,
  entryView,
  foldKeyUses,
  groupActivity,
  hasDetails,
  matchesFilter,
} from "../agent/activity.ts";
import { ChangeRow, type UndoStatus } from "../agent/ChangeRow.tsx";
import { type AgentChange, type AgentModel, emptyAgentModel } from "../agent/model.ts";
import { PlanStrip } from "../agent/PlanStrip.tsx";
import { planPhase } from "../agent/plan-state.ts";
import { ResearchSources } from "../agent/ResearchSources.tsx";
import { StepPreviewScope } from "../agent/StepPreview.tsx";
import { SubagentList } from "../agent/SubagentList.tsx";
import { UsageFooter } from "../agent/UsageFooter.tsx";
import { useFollowScroll } from "../agent/useFollowScroll.ts";
import { useStepHistory } from "../agent/useStepHistory.ts";
import { BrowserDownloads } from "../browser/BrowserDownloads.tsx";
import { isLoopbackPage } from "../deliverables/api.ts";
import { HandedOverFiles, latestFiles } from "../deliverables/HandedOverFiles.tsx";
import type { ApiClient } from "../lib/api.ts";
import { type Previews, PreviewsScope } from "../previews/PreviewsContext.tsx";
import { PreviewsPanel } from "../previews/PreviewsPanel.tsx";
import { timeLabel } from "../replay/replay-view.ts";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { Button } from "../ui/Button.tsx";
import { GroupHeading } from "../ui/GroupHeading.tsx";
import { Icon } from "../ui/Icon.tsx";
import type { IconName } from "../ui/icons.ts";
import { useMediaQuery } from "../ui/media.ts";
import { pressHandlers } from "../ui/press.ts";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { SegmentedControl, type SegmentItem } from "../ui/SegmentedControl.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { SwipePanels } from "../ui/SwipePanels.tsx";
import { TabPanel, Tabs } from "../ui/Tabs.tsx";
import { useVirtualRows } from "../ui/useVirtualRows.ts";
import { VirtualList } from "../ui/VirtualList.tsx";
import { activityTabs as chosenTabs, onActivityTab } from "./activity-tabs.ts";
import { HANDHELD } from "./layout.ts";
import "../agent/activity.css";

export interface ActivityRailProps {
  rows: TimelineRow<StepRowView>[];
  keyUses?: readonly KeyUseState[];
  sessionId: string | null;
  // What the steps say while there are none, in place of their own words.
  empty?: string;
  cellId?: string;
  releaseReady?: boolean;
  scale: number;
  api: ApiClient;
  asOfMs?: number;
  // The session's now, for the clock on the step dot is taking; without it that clock counts by
  // itself.
  nowMs?: number;
  // The task's history is in, so a file handed over from now on is new.
  historyLoaded?: boolean;
  onSelect?(stepId: string): void;
  planSnapshot?: PlanItemState[];
  agent?: AgentModel;
  models?: TaskModelSelection;
  modelName?(provider: string, model: string): string | undefined;
  // Opens the spending limits from the usage popover.
  onSpending?(trigger: HTMLElement): void;
  // The owner's previews of the servers dot starts in the computer; none in Replay.
  previews?: Previews | null;
  memoryAction?: (change: AgentChange) => {
    status?: UndoStatus;
    onUndo?: (changeId: string) => void;
    onReread?: (trigger: HTMLButtonElement) => void;
  };
}

const FILTERS = [
  { value: "all", label: "All" },
  { value: "screen", label: "Screen" },
  { value: "tools", label: "Tools" },
] as const;
const estimateStep = () => 64;
const entryKey = (entry: ActivityEntry) => entry.key;
const changeKey = (change: AgentChange) => change.id;
const EMPTY = emptyAgentModel();
// dot is still at the task, so the user can still change how far it reads.
const WORKING = new Set(["thinking", "acting", "observing", "waiting_user", "paused"]);

type RailTab = "steps" | "files" | "sources" | "agents" | "previews";
// What each tab shows in place of its name while the names don't fit.
const TAB_ICONS: Record<RailTab, IconName> = {
  steps: "list",
  files: "file",
  sources: "library",
  agents: "bot",
  previews: "app-window",
};
// Seen indicators are transient; the selected tab is saved separately per task.
const seenFiles = new Map<string, number>();

export function ActivityRail({
  rows,
  keyUses,
  sessionId,
  empty,
  cellId,
  releaseReady = false,
  scale,
  api,
  agent,
  memoryAction,
  models,
  modelName,
  onSpending,
  asOfMs,
  nowMs,
  historyLoaded = false,
  onSelect,
  planSnapshot,
  previews = null,
}: ActivityRailProps) {
  const phone = useMediaQuery(HANDHELD);
  const replay = asOfMs !== undefined;
  const model = agent ?? EMPTY;
  const ended = !!model.ended;
  const owner = sessionId ?? "";
  const domId = useId();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [opened, setOpened] = useState<{ owner: string; key: string } | null>(null);
  const entries = useMemo(
    () => foldKeyUses(activityRows(rows, { steps: model.steps }, keyUses)),
    [rows, model.steps, keyUses],
  );
  const selected = useMemo(
    () => entries.filter((entry) => matchesFilter(entry.row, filter)),
    [entries, filter],
  );

  const history = useStepHistory(selected, entryKey, `${owner}:${filter}`);
  const viewOf = useMemo(() => {
    const changes = new Map<string, AgentChange[]>();
    for (const change of model.changes) {
      if (!change.step) continue;
      const own = changes.get(change.step) ?? [];
      own.push(change);
      changes.set(change.step, own);
    }
    // Keyed by the entry itself: another task's step with the same id is another entry.
    const cache = new WeakMap<ActivityEntry, EntryView>();
    return (entry: ActivityEntry): EntryView => {
      const found = cache.get(entry);
      if (found) return found;
      const view = entryView(entry, changes.get(entry.row.id) ?? [], ended);
      cache.set(entry, view);
      return view;
    };
  }, [model.changes, ended]);
  const plan = planSnapshot ?? model.plan;
  const handed = useMemo(() => latestFiles(model.results).length, [model.results]);
  const started = !!sessionId || !!plan.length;
  const [downloads, setDownloads] = useState(0);
  const fileChanges = model.changes.filter((change) => change.type !== "memory");
  const memoryChanges = model.changes.filter((change) => change.type === "memory");
  const files = (sessionId ? handed : 0) + downloads + model.changes.length;
  const research = sessionId ? model.research : undefined;
  const showPreviews = !!previews && !replay && !!sessionId;
  const [picked, setPicked] = useState<{ owner: string; tab: RailTab } | null>(null);
  // A tab chosen before any task started stays chosen once one does.
  const lastOwner = useRef(owner);
  if (lastOwner.current !== owner) {
    const before = chosenTabs.get(lastOwner.current);
    if (lastOwner.current === "" && before && !chosenTabs.has(owner)) chosenTabs.set(owner, before);
    lastOwner.current = owner;
  }
  const localPick = picked?.owner === owner ? picked.tab : null;
  const wanted = localPick ?? chosenTabs.get(owner) ?? "steps";
  // A tab stays while it is chosen, so a download's last word is not whisked away with it.
  const tab: RailTab =
    (wanted === "files" && (files > 0 || localPick === "files")) ||
    (wanted === "sources" && research) ||
    (wanted === "previews" && showPreviews) ||
    wanted === "agents"
      ? wanted
      : "steps";
  const choose = (next: string) => {
    chosenTabs.set(owner, next as RailTab);
    setPicked({ owner, tab: next as RailTab });
  };
  const chooseNow = useRef(choose);
  chooseNow.current = choose;
  useEffect(() => onActivityTab((next) => chooseNow.current(next)), []);
  useEffect(() => {
    if (historyLoaded && (tab === "files" || !seenFiles.has(owner))) seenFiles.set(owner, handed);
  }, [historyLoaded, owner, tab, handed]);
  const fresh = tab !== "files" && handed > (seenFiles.get(owner) ?? handed);
  const tabs: SegmentItem[] = [
    { value: "steps", label: "Steps", icon: TAB_ICONS.steps, count: entries.length || undefined },
    ...(tab === "files" || files > 0
      ? [
          {
            value: "files",
            label: "Files",
            icon: TAB_ICONS.files,
            count: files || undefined,
            fresh,
          },
        ]
      : []),
    ...(research
      ? [
          {
            value: "sources",
            label: "Sources",
            icon: TAB_ICONS.sources,
            count: research.sources.length,
          },
        ]
      : []),
    {
      value: "agents",
      label: "Agents",
      icon: TAB_ICONS.agents,
      count: model.subagents.size || undefined,
    },
    ...(showPreviews ? [{ value: "previews", label: "Previews", icon: TAB_ICONS.previews }] : []),
  ];
  const tabKey = tabs.map((item) => item.value).join(",");
  const tabValues = useMemo(() => tabKey.split(","), [tabKey]);
  const onSteps = tab === "steps";
  const follow = useFollowScroll(`${owner}:${filter}`, !replay && started);
  const timeline = useRef<HTMLElement>(null);

  const steps = entries.filter((entry) => entry.row.kind === "step");
  const currentKey =
    asOfMs !== undefined
      ? steps.findLast((entry) => entry.row.kind === "step" && entry.row.startT <= asOfMs)?.key
      : (() => {
          const last = steps.at(-1);
          return last && viewOf(last).state === "doing" ? last.key : undefined;
        })();
  const openKey = opened?.owner === owner ? opened.key : null;
  const [expanded, setExpanded] = useState<{ owner: string; keys: Set<string> }>({
    owner,
    keys: new Set(),
  });
  const groups = useMemo(() => groupActivity(history.rows), [history.rows]);
  const display = useMemo(
    () =>
      groups.flatMap<{
        key: string;
        entry?: ActivityEntry;
        child?: boolean;
        group?: (typeof groups)[number];
      }>((group) => {
        if (group.entries.length === 1 || replay)
          return group.entries.map((entry) => ({ key: entry.key, entry }));
        const header = { key: `group-${group.key}`, group };
        return expanded.owner === owner && expanded.keys.has(group.key)
          ? [header, ...group.entries.map((entry) => ({ key: entry.key, entry, child: true }))]
          : [header];
      }),
    [groups, expanded, owner, replay],
  );
  const virtualKeys = useMemo(() => display.map((item) => item.key), [display]);
  const virtual = useVirtualRows(timeline, virtualKeys, estimateStep, { anchored: true });

  // When embedded without its own scroll constraint, bring the live step into the outer scroller.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const pane = timeline.current?.closest<HTMLElement>(".activity-scroll");
    if (placed.current || !currentKey || !pane) return;
    placed.current = true;
    if (pane.scrollHeight > pane.clientHeight + 1) return;
    timeline.current?.querySelector("[data-current]")?.scrollIntoView?.({ block: "nearest" });
  }, [currentKey]);

  useEffect(() => {
    if (!replay || !currentKey) return;
    const index = display.findIndex((item) => item.key === currentKey);
    if (index >= 0) virtual.scrollTo(index);
    reveal(timeline.current?.querySelector("[data-current]") ?? null);
  }, [replay, currentKey, display, virtual.scrollTo]);

  const older = () => {
    const pane = timeline.current?.closest<HTMLElement>(".activity-scroll");
    const top = pane?.getBoundingClientRect().top ?? 0;
    const anchor = [
      ...(timeline.current?.querySelectorAll<HTMLElement>("[data-anchor]") ?? []),
    ].find((row) => row.getBoundingClientRect().bottom > top);
    if (anchor) follow.anchorTo(anchor);
    history.older();
  };
  useEffect(() => {
    const freezeSelection = () => {
      const selection = window.getSelection();
      if (
        timeline.current &&
        selection &&
        !selection.isCollapsed &&
        selection.rangeCount &&
        selection.getRangeAt(0).intersectsNode(timeline.current)
      )
        history.freeze();
    };
    document.addEventListener("selectionchange", freezeSelection);
    return () => document.removeEventListener("selectionchange", freezeSelection);
  }, [history.freeze]);

  const toggleKey = (key: string, trigger: HTMLButtonElement) => {
    const row = trigger.closest(".activity-row");
    if (row instanceof HTMLElement) follow.anchorTo(row);
    const next = openKey === key ? null : key;
    setOpened(next ? { owner, key: next } : null);
    if (next) revealOpened(row);
  };
  const toggle = (entry: ActivityEntry, trigger: HTMLButtonElement) => {
    toggleKey(entry.key, trigger);
    if (replay && entry.row.kind === "step") onSelect?.(entry.row.id);
  };

  const renderEntry = (entry: ActivityEntry) => {
    const view = viewOf(entry);
    const running = entry.key === currentKey && !view.time && !replay;
    const expandable = !!sessionId && hasDetails(entry, model.changes);
    return (
      <ActivityRow
        key={entry.key}
        id={`${domId}-${entry.key}`}
        view={view}
        runningFrom={running ? view.startT : undefined}
        nowMs={nowMs}
        current={entry.key === currentKey}
        future={asOfMs !== undefined && entry.row.kind === "step" && entry.row.startT > asOfMs}
        open={openKey === entry.key}
        onToggle={expandable ? (trigger) => toggle(entry, trigger) : undefined}
      >
        {expandable && sessionId && (
          <ActivityDetail
            entry={entry}
            changes={model.changes}
            api={api}
            sessionId={sessionId}
            scale={scale}
            replay={replay}
          />
        )}
      </ActivityRow>
    );
  };

  const changeRow = (change: AgentChange) => (
    <ChangeRow
      key={change.id}
      id={`${domId}-change-${change.id}`}
      change={change}
      changes={model.changes}
      open={openKey === `change-${change.id}`}
      onToggle={(trigger) => toggleKey(`change-${change.id}`, trigger)}
      {...(change.type === "memory" ? memoryAction?.(change) : {})}
    />
  );

  const content = (
    <aside className="rail r activity-rail" aria-label="Plan and steps">
      {/* A tab or the column names it on screen; Replay's transport says how far its record runs. */}
      <div className="ui-visually-hidden">
        <h2>Activity</h2>
        {replay && <span className="num">As of {timeLabel(asOfMs)}</span>}
      </div>
      <div className="activity-controls">
        {(started || tabs.length > 1) && (
          <div className="activity-tabs-row">
            <Tabs
              id={`${domId}-tabs`}
              aria-label="Activity"
              size={32}
              variant="line"
              className="activity-tabs"
              items={tabs}
              value={tab}
              onValueChange={choose}
            />
          </div>
        )}
      </div>
      {plan.length > 0 && (
        <div className="activity-plan">
          <PlanStrip
            plan={plan}
            phase={planPhase(model)}
            label={replay ? "Plan at replay time" : "Task plan"}
          />
        </div>
      )}
      <div className="activity-body">
        <SwipePanels enabled={phone} value={tab} values={tabValues} onValueChange={choose}>
          <TabPanel tabsId={`${domId}-tabs`} value="steps" selected={tab} swipe={phone}>
            {started && entries.length > 0 && (
              <div className="activity-filter">
                <SegmentedControl
                  aria-label="Activity filter"
                  size={32}
                  variant="quiet"
                  items={FILTERS}
                  value={filter}
                  onValueChange={(value) => setFilter(value as ActivityFilter)}
                />
              </div>
            )}
            <ScrollArea
              ref={follow.ref}
              className="activity-scroll"
              onScroll={(event) => {
                if (!follow.onScroll()) {
                  history.freeze();
                  if (onSteps && history.hasOlder && event.currentTarget.scrollTop < 32) older();
                }
              }}
              {...follow.gestures(history.freeze)}
            >
              <div className="activity-content">
                {!started && (
                  <p className="activity-empty">Plan and steps appear here once dot starts.</p>
                )}
                {history.hasOlder && (
                  <Button className="activity-page" size="sm" variant="quiet" onClick={older}>
                    Earlier steps
                  </Button>
                )}
                {started && (
                  <section ref={timeline} className="activity-timeline" aria-label="Recorded steps">
                    <div aria-hidden="true" style={{ height: virtual.before, flexShrink: 0 }} />
                    {sessionId &&
                      virtual.indexes.map((index) => {
                        const item = display[index];
                        if (!item) return null;
                        const group = item.group;
                        const isOpen =
                          !!group && expanded.owner === owner && expanded.keys.has(group.key);
                        return (
                          <div
                            key={item.key}
                            data-index={index}
                            data-last={index === display.length - 1 || undefined}
                            ref={virtual.measure}
                            className="activity-window-row"
                            data-group-child={item.child || undefined}
                          >
                            {item.entry
                              ? renderEntry(item.entry)
                              : group && (
                                  <GroupHeading
                                    className="activity-read-group"
                                    leading={<StatusGlyph state="done" />}
                                    title={group.label}
                                    meta={`${group.entries.length} read-only steps · ${isOpen ? "Hide" : "Show"} details`}
                                    count={group.entries.length}
                                    open={isOpen}
                                    onToggle={(trigger) => {
                                      follow.anchorTo(trigger);
                                      setExpanded((previous) => {
                                        const keys = new Set(
                                          previous.owner === owner ? previous.keys : [],
                                        );
                                        if (keys.has(group.key)) keys.delete(group.key);
                                        else keys.add(group.key);
                                        return { owner, keys };
                                      });
                                    }}
                                  />
                                )}
                          </div>
                        );
                      })}
                    <div aria-hidden="true" style={{ height: virtual.after, flexShrink: 0 }} />
                  </section>
                )}
                {started && (!sessionId || !selected.length) && (
                  <p className="activity-empty">
                    {sessionId && entries.length
                      ? "No steps match this filter."
                      : (empty ??
                        (replay
                          ? "No steps to show for this recording."
                          : "Steps appear here as dot works."))}
                  </p>
                )}
                {model.historyTruncated && (
                  <p className="activity-note">Older activity is kept in the task log.</p>
                )}
              </div>
            </ScrollArea>
          </TabPanel>
          {/* Keep downloads mounted so their count can reveal Files before its first selection.
              A panel absent from the swipe list must stay hidden even on a phone. */}
          {(tabValues.includes("files") || (cellId && !replay)) && (
            <TabPanel
              tabsId={`${domId}-tabs`}
              value="files"
              selected={tab}
              swipe={phone && tabValues.includes("files")}
            >
              <ScrollArea className="activity-scroll">
                <div className="activity-content">
                  {handed > 0 && sessionId && (
                    <section className="activity-section" aria-labelledby={`${domId}-handed`}>
                      <div className="activity-section-head">
                        <h3 id={`${domId}-handed`}>Handed over</h3>
                        <span className="activity-section-meta num">{handed}</span>
                      </div>
                      <HandedOverFiles
                        api={api}
                        sessionId={sessionId}
                        results={model.results}
                        onMac={isLoopbackPage()}
                      />
                    </section>
                  )}
                  {cellId && !replay && (
                    <BrowserDownloads
                      key={cellId}
                      api={api}
                      cellId={cellId}
                      releaseReady={releaseReady}
                      onCount={setDownloads}
                    />
                  )}
                  {fileChanges.length > 0 && (
                    <section className="activity-section" aria-labelledby={`${domId}-changed`}>
                      <div className="activity-section-head">
                        <h3 id={`${domId}-changed`}>Changed</h3>
                        <span className="activity-section-meta num">{fileChanges.length}</span>
                      </div>
                      <VirtualList items={fileChanges} itemKey={changeKey}>
                        {changeRow}
                      </VirtualList>
                    </section>
                  )}
                  {memoryChanges.length > 0 && (
                    <section className="activity-section" aria-labelledby={`${domId}-memory`}>
                      <div className="activity-section-head">
                        <h3 id={`${domId}-memory`}>Memory</h3>
                        <span className="activity-section-meta num">{memoryChanges.length}</span>
                      </div>
                      <VirtualList items={memoryChanges} itemKey={changeKey}>
                        {changeRow}
                      </VirtualList>
                    </section>
                  )}
                  {!files && <p className="activity-empty">Files dot hands over appear here.</p>}
                </div>
              </ScrollArea>
            </TabPanel>
          )}
          {research && sessionId && (
            <TabPanel tabsId={`${domId}-tabs`} value="sources" selected={tab} swipe={phone}>
              <ScrollArea className="activity-scroll">
                <div className="activity-content">
                  <ResearchSources
                    research={research}
                    nowMs={replay ? asOfMs : nowMs}
                    working={!replay && !ended && WORKING.has(model.state?.state ?? "")}
                    api={api}
                    sessionId={sessionId}
                  />
                </div>
              </ScrollArea>
            </TabPanel>
          )}
          <TabPanel tabsId={`${domId}-tabs`} value="agents" selected={tab} swipe={phone}>
            <SubagentList agents={model.subagents} />
          </TabPanel>
          {showPreviews && (
            <TabPanel tabsId={`${domId}-tabs`} value="previews" selected={tab} swipe={phone}>
              <ScrollArea className="activity-scroll">
                <div className="activity-content">
                  <PreviewsPanel active={tab === "previews"} />
                </div>
              </ScrollArea>
            </TabPanel>
          )}
        </SwipePanels>
        {!replay && started && onSteps && (
          <button
            {...pressHandlers}
            type="button"
            className="activity-jump"
            data-shown={!follow.pinned || undefined}
            inert={follow.pinned}
            onClick={() => {
              follow.jump();
            }}
          >
            <Icon name="arrow-down" size={14} />
            Jump to latest
          </button>
        )}
      </div>
      {agent && sessionId && (
        <UsageFooter
          model={model}
          selection={models}
          modelName={modelName}
          onSpending={onSpending}
        />
      )}
    </aside>
  );
  const scoped = (
    <StepPreviewScope api={api} sessionId={owner} results={model.results} scale={scale}>
      {content}
    </StepPreviewScope>
  );
  return <PreviewsScope value={replay ? null : previews}>{scoped}</PreviewsScope>;
}
