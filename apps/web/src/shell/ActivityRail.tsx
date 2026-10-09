import type { TaskModelSelection } from "@localdot/protocol";
import type { KeyUseState, PlanItemState } from "@localdot/stage";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ActivityDetail } from "../agent/ActivityDetails.tsx";
import { ActivityRow } from "../agent/ActivityRow.tsx";
import {
  type ActivityEntry,
  type ActivityFilter,
  type ActivityGroup,
  activityRows,
  clock,
  type EntryView,
  entryView,
  foldKeyUses,
  groupEntries,
  groupMeta,
  hasDetails,
  matchesFilter,
  runsOnView,
} from "../agent/activity.ts";
import { ChangeRow, type UndoStatus } from "../agent/ChangeRow.tsx";
import { type AgentChange, type AgentModel, emptyAgentModel } from "../agent/model.ts";
import { PlanView } from "../agent/PlanView.tsx";
import { UsageFooter } from "../agent/UsageFooter.tsx";
import { reducedMotion, useFollowScroll } from "../agent/useFollowScroll.ts";
import { usePagedRows } from "../agent/usePagedRows.ts";
import { BrowserDownloads } from "../browser/BrowserDownloads.tsx";
import { count } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { timeLabel } from "../replay/replay-view.ts";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { Button } from "../ui/Button.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Icon } from "../ui/Icon.tsx";
import { pressHandlers } from "../ui/press.ts";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import "../agent/activity.css";

export interface ActivityRailProps {
  rows: TimelineRow<StepRowView>[];
  keyUses?: readonly KeyUseState[];
  sessionId: string | null;
  cellId?: string;
  releaseReady?: boolean;
  scale: number;
  api: ApiClient;
  asOfMs?: number;
  onSelect?(stepId: string): void;
  planSnapshot?: PlanItemState[];
  // False where a tab names the rail: its title is left to screen readers.
  titled?: boolean;
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

interface FollowedRun {
  owner: string;
  run: string | null;
  watched: string | null;
}

function reveal(element: Element | null) {
  element?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
}

export function ActivityRail({
  rows,
  keyUses,
  sessionId,
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
  onSelect,
  planSnapshot,
  titled = true,
}: ActivityRailProps) {
  const replay = asOfMs !== undefined;
  const model = agent ?? EMPTY;
  const ended = !!model.ended;
  const owner = sessionId ?? "";
  const domId = useId();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [opened, setOpened] = useState<{ owner: string; key: string } | null>(null);
  const [groupsOpen, setGroupsOpen] = useState<{ owner: string; open: Record<string, boolean> }>({
    owner,
    open: {},
  });
  const entries = useMemo(
    () => foldKeyUses(activityRows(rows, agent, keyUses)),
    [rows, agent, keyUses],
  );
  const selected = useMemo(
    () => entries.filter((entry) => matchesFilter(entry.row, filter)),
    [entries, filter],
  );
  const page = usePagedRows(selected, entryKey, `${owner}:${filter}`);
  const runs = useMemo(() => groupEntries(entries), [entries]);
  const groups = useMemo(() => runsOnView(runs, page.rows), [runs, page.rows]);
  const views = useMemo(
    () =>
      new Map<string, EntryView>(
        page.rows.map((entry) => [entry.key, entryView(entry, model.changes, ended)]),
      ),
    [page.rows, model.changes, ended],
  );
  const plan = planSnapshot ?? model.plan;
  const started = !!sessionId || !!plan.length;
  const follow = useFollowScroll(`${owner}:${filter}`, !replay && started);
  const timeline = useRef<HTMLElement>(null);

  const steps = entries.filter((entry) => entry.row.kind === "step");
  const currentKey =
    asOfMs !== undefined
      ? steps.findLast((entry) => entry.row.kind === "step" && entry.row.startT <= asOfMs)?.key
      : (() => {
          const last = steps.at(-1);
          return last && entryView(last, model.changes, ended).state === "doing"
            ? last.key
            : undefined;
        })();
  const openKey = opened?.owner === owner ? opened.key : null;
  const groupState = groupsOpen.owner === owner ? groupsOpen.open : {};
  // Runs older than the followed one fold, but only while the reader follows the live end, where the
  // end stays put. The run the reader watched until a new one started stays open until the next.
  const lastRun = runs.at(-1)?.id ?? null;
  const [followed, setFollowed] = useState<FollowedRun>({ owner, run: lastRun, watched: null });
  if (followed.owner !== owner) setFollowed({ owner, run: lastRun, watched: null });
  else if (followed.run !== lastRun && (follow.pinned || followed.run === null))
    setFollowed({
      owner,
      run: lastRun,
      watched: followed.run !== null && runs.at(-2)?.id === followed.run ? followed.run : null,
    });
  const runIndex = new Map(runs.map((run, index) => [run.id, index]));
  const foldBefore = runIndex.get(followed.run ?? "") ?? 0;
  const planText = new Map(plan.map((item) => [item.id, item.text]));
  const headed = runs.length > 1 || (runs[0] !== undefined && runs[0].planItem !== null);

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
    const view = views.get(entry.key) ?? entryView(entry, model.changes, ended);
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

  const renderRun = (group: ActivityGroup) => {
    const meta = groupMeta(
      group.entries.map((entry) => views.get(entry.key) ?? entryView(entry, model.changes, ended)),
    );
    const holdsOpen = group.entries.some(
      (entry) => entry.key === openKey || entry.key === currentKey,
    );
    const open =
      groupState[group.id] ??
      (holdsOpen ||
        group.id === followed.watched ||
        (runIndex.get(group.id) ?? Number.POSITIVE_INFINITY) >= foldBefore);
    return (
      <Disclosure
        key={group.id}
        className="activity-group"
        data-anchor=""
        summary={(group.planItem && planText.get(group.planItem)) || "Other steps"}
        meta={[
          meta.steps ? count(meta.steps, "step", "steps") : "",
          meta.failed ? `${meta.failed} failed` : "",
          meta.durationMs >= 1000 ? clock(meta.durationMs) : "",
        ]
          .filter(Boolean)
          .join(" · ")}
        open={open}
        onClick={(event) => follow.anchorTo(event.currentTarget)}
        onOpenChange={(next) => setGroupsOpen({ owner, open: { ...groupState, [group.id]: next } })}
      >
        <div className="activity-group-rows">{group.entries.map(renderEntry)}</div>
      </Disclosure>
    );
  };

  const loose = model.changes.filter(
    (change) =>
      change.type === "memory" ||
      !change.step ||
      !entries.some((entry) => entry.row.kind === "step" && entry.row.id === change.step),
  );

  return (
    <aside className="rail r activity-rail" aria-label="Plan and steps">
      <div className={titled ? "rail-h" : "ui-visually-hidden"}>
        <h2>Activity</h2>
        {replay && <span className="num">As of {timeLabel(asOfMs)}</span>}
      </div>
      <div className="activity-body">
        <ScrollArea
          ref={follow.ref}
          className="activity-scroll"
          fade={plan.length ? "bottom" : "both"}
          onScroll={(event) => {
            // Only the reader leaving the live end holds the page; the rail's own glides do not.
            const pane = event.currentTarget;
            if (!follow.onScroll() && pane.scrollHeight - pane.clientHeight - pane.scrollTop >= 32)
              page.freeze();
          }}
          onWheel={follow.interrupt}
          onTouchStart={follow.interrupt}
          onPointerDown={follow.interrupt}
          onKeyDown={follow.interrupt}
        >
          <div className="activity-content">
            {!started && (
              <p className="activity-empty">Plan and steps appear here once dot starts.</p>
            )}
            {plan.length > 0 && (
              <PlanView plan={plan} label={replay ? "Plan at replay time" : "Task plan"} />
            )}
            {model.activity && started && (
              <div className="activity-extras">
                <Disclosure summary="Thinking notes" className="activity-disclosure">
                  <p className="activity-notes">{model.activity}</p>
                </Disclosure>
              </div>
            )}
            {cellId && !replay && (
              <BrowserDownloads
                key={cellId}
                api={api}
                cellId={cellId}
                releaseReady={releaseReady}
              />
            )}
            {loose.length > 0 && (
              <section className="activity-section" aria-label="Changes">
                <h3 className="activity-section-title">Changes</h3>
                {loose.map((change) => (
                  <ChangeRow
                    key={change.id}
                    id={`${domId}-change-${change.id}`}
                    change={change}
                    changes={model.changes}
                    open={openKey === `change-${change.id}`}
                    onToggle={(trigger) => toggleKey(`change-${change.id}`, trigger)}
                    {...(change.type === "memory" ? memoryAction?.(change) : {})}
                  />
                ))}
              </section>
            )}
            {started && (
              <section className="activity-steps" aria-labelledby={`${domId}-steps`}>
                <div className="activity-steps-head">
                  <h3 id={`${domId}-steps`}>Steps</h3>
                  <SegmentedControl
                    aria-label="Activity filter"
                    size={24}
                    items={FILTERS}
                    value={filter}
                    onValueChange={(value) => setFilter(value as ActivityFilter)}
                  />
                </div>
                {page.hasOlder && (
                  <Button variant="quiet" size="sm" className="activity-page" onClick={page.older}>
                    Older steps
                  </Button>
                )}
                <section
                  ref={timeline}
                  className="activity-timeline"
                  aria-label="Recorded steps"
                  onPointerDownCapture={() => page.freeze()}
                >
                  {sessionId && (headed ? groups.map(renderRun) : page.rows.map(renderEntry))}
                </section>
                {page.hasNewer && (
                  <Button variant="quiet" size="sm" className="activity-page" onClick={page.newer}>
                    Newer steps
                  </Button>
                )}
                {page.retained && (
                  <p className="activity-note">This page stays put while dot keeps working.</p>
                )}
                {(!sessionId || !page.rows.length) && (
                  <p className="activity-empty">
                    {!sessionId || !entries.length
                      ? "Steps appear here as dot works."
                      : "No steps match this filter."}
                  </p>
                )}
              </section>
            )}
            {model.historyTruncated && (
              <p className="activity-note">Older activity is kept in the task log.</p>
            )}
          </div>
        </ScrollArea>
        {!replay && started && (
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
