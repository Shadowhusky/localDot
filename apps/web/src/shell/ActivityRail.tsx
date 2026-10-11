import type { TaskModelSelection } from "@localdot/protocol";
import type { KeyUseState, PlanItemState } from "@localdot/stage";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityDetail } from "../agent/ActivityDetails.tsx";
import { ActivityRow } from "../agent/ActivityRow.tsx";
import {
  type ActivityEntry,
  type ActivityFilter,
  activityRows,
  clock,
  type EntryView,
  entryView,
  foldKeyUses,
  hasDetails,
  matchesFilter,
  withNextMoves,
} from "../agent/activity.ts";
import { ChangeRow, type UndoStatus } from "../agent/ChangeRow.tsx";
import { type AgentChange, type AgentModel, emptyAgentModel } from "../agent/model.ts";
import { PlanStrip } from "../agent/PlanStrip.tsx";
import { ResearchSources } from "../agent/ResearchSources.tsx";
import { UsageFooter } from "../agent/UsageFooter.tsx";
import { reducedMotion, useFollowScroll } from "../agent/useFollowScroll.ts";
import { usePagedRows } from "../agent/usePagedRows.ts";
import { BrowserDownloads } from "../browser/BrowserDownloads.tsx";
import { isLoopbackPage } from "../deliverables/api.ts";
import { HandedOverFiles, latestFiles } from "../deliverables/HandedOverFiles.tsx";
import type { ApiClient } from "../lib/api.ts";
import { timeLabel } from "../replay/replay-view.ts";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { pressHandlers } from "../ui/press.ts";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { SegmentedControl, type SegmentItem } from "../ui/SegmentedControl.tsx";
import { TabPanel, Tabs } from "../ui/Tabs.tsx";
import { activityTabs as chosenTabs } from "./activity-tabs.ts";
import "../agent/activity.css";

export interface ActivityRailProps {
  onHide?(): void;
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
  // The session's now, for the clock on the step dot is taking.
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
const entryKey = (entry: ActivityEntry) => entry.key;
// Long enough for a row's detail to finish opening before it is brought into view.
const REVEAL_AFTER = 300;
const EMPTY = emptyAgentModel();
// dot is still at the task, so the user can still change how far it reads.
const WORKING = new Set(["thinking", "acting", "observing", "waiting_user", "paused"]);

type RailTab = "steps" | "files" | "sources";
// Seen indicators are transient; the selected tab is saved separately per task.
const seenFiles = new Map<string, number>();

function reveal(element: Element | null) {
  element?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
}

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
  onHide,
}: ActivityRailProps) {
  const replay = asOfMs !== undefined;
  const model = agent ?? EMPTY;
  const ended = !!model.ended;
  const owner = sessionId ?? "";
  const domId = useId();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [opened, setOpened] = useState<{ owner: string; key: string } | null>(null);
  const entries = useMemo(
    () => foldKeyUses(activityRows(rows, agent, keyUses)),
    [rows, agent, keyUses],
  );
  const selected = useMemo(
    () => entries.filter((entry) => matchesFilter(entry.row, filter)),
    [entries, filter],
  );
  const page = usePagedRows(selected, entryKey, `${owner}:${filter}`);
  // Views come from the whole history, so a failure says what dot did next even when the filter
  // or the page hides that step.
  const views = useMemo(() => {
    const all = withNextMoves(entries.map((entry) => entryView(entry, model.changes, ended)));
    return new Map(entries.map((entry, index) => [entry.key, all[index] as EntryView]));
  }, [entries, model.changes, ended]);
  const viewOf = (entry: ActivityEntry) => views.get(entry.key) as EntryView;
  const plan = planSnapshot ?? model.plan;
  const handed = useMemo(() => latestFiles(model.results).length, [model.results]);
  const started = !!sessionId || !!plan.length;
  const [downloads, setDownloads] = useState(0);
  const fileChanges = model.changes.filter((change) => change.type !== "memory");
  const memoryChanges = model.changes.filter((change) => change.type === "memory");
  const files = (sessionId ? handed : 0) + downloads + model.changes.length;
  const research = sessionId ? model.research : undefined;
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
    (wanted === "sources" && research)
      ? wanted
      : "steps";
  const choose = (next: string) => {
    chosenTabs.set(owner, next as RailTab);
    setPicked({ owner, tab: next as RailTab });
  };
  useEffect(() => {
    if (historyLoaded && (tab === "files" || !seenFiles.has(owner))) seenFiles.set(owner, handed);
  }, [historyLoaded, owner, tab, handed]);
  const fresh = tab !== "files" && handed > (seenFiles.get(owner) ?? handed);
  const tabs: SegmentItem[] = [
    { value: "steps", label: "Steps", count: entries.length || undefined },
    ...(tab === "files" || files > 0
      ? [{ value: "files", label: "Files", count: files || undefined, fresh }]
      : []),
    ...(research ? [{ value: "sources", label: "Sources", count: research.sources.length }] : []),
  ];
  const onSteps = tab === "steps";
  const follow = useFollowScroll(`${owner}:${filter}:${tab}`, !replay && started && onSteps);
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
  // A phone's sheet scrolls Activity whole, out of the rail's own following, so it brings the live
  // step into view itself once there is one.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const pane = timeline.current?.closest<HTMLElement>(".activity-scroll");
    if (placed.current || !currentKey || !pane) return;
    placed.current = true;
    if (pane.scrollHeight > pane.clientHeight + 1) return;
    timeline.current?.querySelector("[data-current]")?.scrollIntoView?.({ block: "nearest" });
  }, [currentKey]);
  useEffect(() => {
    const pane = timeline.current;
    const preserveSelection = () => {
      const selection = window.getSelection();
      if (!pane || !selection || selection.isCollapsed || !selection.rangeCount) return;
      if (selection.getRangeAt(0).intersectsNode(pane)) page.freeze();
    };
    document.addEventListener("selectionchange", preserveSelection);
    return () => document.removeEventListener("selectionchange", preserveSelection);
  }, [page.freeze]);

  useEffect(() => {
    if (!replay || !currentKey) return;
    reveal(timeline.current?.querySelector("[data-current]") ?? null);
  }, [replay, currentKey]);

  const toggleKey = (key: string, trigger: HTMLButtonElement) => {
    const row = trigger.closest(".activity-row");
    if (row instanceof HTMLElement) follow.anchorTo(row);
    const next = openKey === key ? null : key;
    setOpened(next ? { owner, key: next } : null);
    if (next) window.setTimeout(() => reveal(row), REVEAL_AFTER);
  };
  const toggle = (entry: ActivityEntry, trigger: HTMLButtonElement) => {
    toggleKey(entry.key, trigger);
    if (replay && entry.row.kind === "step") onSelect?.(entry.row.id);
  };

  const renderEntry = (entry: ActivityEntry) => {
    const shown = viewOf(entry);
    const view =
      entry.key === currentKey && !shown.time && nowMs !== undefined && !replay
        ? { ...shown, time: clock(Math.max(0, nowMs - shown.startT)) }
        : shown;
    const expandable = !!sessionId && hasDetails(entry, model.changes);
    return (
      <ActivityRow
        key={entry.key}
        id={`${domId}-${entry.key}`}
        view={view}
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

  return (
    <aside className="rail r activity-rail" aria-label="Plan and steps">
      {/* A tab or the column names it on screen; Replay's transport says how far its record runs. */}
      <div className="ui-visually-hidden">
        <h2>Activity</h2>
        {replay && <span className="num">As of {timeLabel(asOfMs)}</span>}
      </div>
      {plan.length > 0 && (
        <PlanStrip plan={plan} label={replay ? "Plan at replay time" : "Task plan"} />
      )}
      {(started || tabs.length > 1 || onHide) && (
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
          {onHide && <IconButton icon="x" label="Hide activity" size={28} onClick={onHide} />}
        </div>
      )}
      <div className="activity-body">
        <ScrollArea
          ref={follow.ref}
          className="activity-scroll"
          onScroll={(event) => {
            // Only the reader leaving the live end holds the page; the rail's own glides do not.
            const pane = event.currentTarget;
            if (
              onSteps &&
              !follow.onScroll() &&
              pane.scrollHeight - pane.clientHeight - pane.scrollTop >= 32
            )
              page.freeze();
          }}
          onWheel={follow.interrupt}
          onTouchStart={follow.interrupt}
          onPointerDown={follow.interrupt}
          onKeyDown={follow.interrupt}
        >
          <div className="activity-content">
            <TabPanel tabsId={`${domId}-tabs`} value="steps" selected={tab}>
              {!started && (
                <p className="activity-empty">Plan and steps appear here once dot starts.</p>
              )}
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
              {page.hasOlder && (
                <Button variant="quiet" size="sm" className="activity-page" onClick={page.older}>
                  Older steps
                </Button>
              )}
              {started && (
                <section
                  ref={timeline}
                  className="activity-timeline"
                  aria-label="Recorded steps"
                  onPointerDownCapture={() => page.freeze()}
                >
                  {sessionId && page.rows.map(renderEntry)}
                </section>
              )}
              {page.hasNewer && (
                <Button variant="quiet" size="sm" className="activity-page" onClick={page.newer}>
                  Newer steps
                </Button>
              )}
              {page.retained && (
                <p className="activity-note">This page stays put while dot keeps working.</p>
              )}
              {started && (!sessionId || !page.rows.length) && (
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
            </TabPanel>
            <TabPanel tabsId={`${domId}-tabs`} value="files" selected={tab}>
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
                  {fileChanges.map(changeRow)}
                </section>
              )}
              {memoryChanges.length > 0 && (
                <section className="activity-section" aria-labelledby={`${domId}-memory`}>
                  <div className="activity-section-head">
                    <h3 id={`${domId}-memory`}>Memory</h3>
                    <span className="activity-section-meta num">{memoryChanges.length}</span>
                  </div>
                  {memoryChanges.map(changeRow)}
                </section>
              )}
              {!files && <p className="activity-empty">Files dot hands over appear here.</p>}
            </TabPanel>
            {research && sessionId && (
              <TabPanel tabsId={`${domId}-tabs`} value="sources" selected={tab}>
                <ResearchSources
                  research={research}
                  nowMs={replay ? asOfMs : nowMs}
                  working={!replay && !ended && WORKING.has(model.state?.state ?? "")}
                  api={api}
                  sessionId={sessionId}
                />
              </TabPanel>
            )}
          </div>
        </ScrollArea>
        {!replay && started && onSteps && (
          <button
            {...pressHandlers}
            type="button"
            className="activity-jump"
            data-shown={!follow.pinned || undefined}
            inert={follow.pinned}
            onClick={() => {
              page.latest();
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
}
