import type { TaskModelSelection } from "@localdot/protocol";
import type { KeyUseState, PlanItemState } from "@localdot/stage";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
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
  groupEntries,
  groupMeta,
  hasDetails,
  matchesFilter,
  questionView,
} from "../agent/activity.ts";
import { ChangeRow, type UndoStatus } from "../agent/ChangeRow.tsx";
import { type AgentChange, type AgentModel, emptyAgentModel } from "../agent/model.ts";
import { PlanView } from "../agent/PlanView.tsx";
import { ResultFiles } from "../agent/ResultFiles.tsx";
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
  agent?: AgentModel;
  models?: TaskModelSelection;
  knowledge?: ReactNode;
  memoryAction?: (change: AgentChange) => {
    status?: UndoStatus;
    onUndo?: (changeId: string) => void;
    onReread?: () => void;
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
  knowledge,
  asOfMs,
  onSelect,
  planSnapshot,
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
  const groups = useMemo(() => groupEntries(page.rows), [page.rows]);
  const views = useMemo(
    () =>
      new Map<string, EntryView>(
        page.rows.map((entry) => [entry.key, entryView(entry, model.changes, ended)]),
      ),
    [page.rows, model.changes, ended],
  );
  const follow = useFollowScroll(`${owner}:${filter}`, !replay);
  const timeline = useRef<HTMLElement>(null);
  const knowing = useRef<HTMLButtonElement>(null);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const latestGroup = useRef<string | null>(null);

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
  // Older runs fold only while the reader follows the live end, where the end stays put; scrolled
  // back, nothing above them changes height.
  if (follow.pinned || latestGroup.current === null)
    latestGroup.current = groups.at(-1)?.id ?? null;
  const foldBefore = Math.max(
    0,
    groups.findIndex((group) => group.id === latestGroup.current),
  );
  const plan = planSnapshot ?? model.plan;
  const planText = new Map(plan.map((item) => [item.id, item.text]));
  const headed = groups.length > 1 || (groups[0] !== undefined && groups[0].planItem !== null);

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

  // Reading memory again from a change shows what was read, where the stored files are listed.
  const memoryActions = (change: AgentChange) => {
    const actions = memoryAction?.(change);
    const reread = actions?.onReread;
    return {
      ...actions,
      ...(reread
        ? {
            onReread: () => {
              reread();
              setKnowledgeOpen(true);
              window.setTimeout(() => reveal(knowing.current), REVEAL_AFTER);
            },
          }
        : {}),
    };
  };
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

  const loose = model.changes.filter(
    (change) =>
      change.type === "memory" ||
      !change.step ||
      !entries.some((entry) => entry.row.kind === "step" && entry.row.id === change.step),
  );
  const questions = [...model.questions.values()];
  const started = !!sessionId || !!plan.length;

  return (
    <aside className="rail r activity-rail" aria-label="Plan and steps">
      <div className="rail-h">
        <h2>Activity</h2>
        {replay && <span className="num">As of {timeLabel(asOfMs)}</span>}
      </div>
      {!started ? (
        <p className="activity-empty">Plan and steps appear here once dot starts.</p>
      ) : (
        <div className="activity-body">
          <ScrollArea
            ref={follow.ref}
            className="activity-scroll"
            fade={plan.length ? "bottom" : "both"}
            onScroll={(event) => {
              follow.onScroll();
              const pane = event.currentTarget;
              if (pane.scrollHeight - pane.clientHeight - pane.scrollTop >= 32) page.freeze();
            }}
            onWheel={follow.interrupt}
            onTouchStart={follow.interrupt}
          >
            <div className="activity-content">
              {plan.length > 0 && (
                <PlanView plan={plan} label={replay ? "Plan at replay time" : "Task plan"} />
              )}
              {(knowledge || model.activity) && (
                <div className="activity-extras">
                  {model.activity && (
                    <Disclosure summary="Thinking notes" className="activity-disclosure">
                      <p className="activity-notes">{model.activity}</p>
                    </Disclosure>
                  )}
                  {knowledge && (
                    <Disclosure
                      ref={knowing}
                      summary="What dot knows"
                      className="activity-disclosure"
                      open={knowledgeOpen}
                      onOpenChange={setKnowledgeOpen}
                    >
                      {knowledge}
                    </Disclosure>
                  )}
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
                      {...(change.type === "memory" ? memoryActions(change) : {})}
                    />
                  ))}
                </section>
              )}
              {questions.length > 0 && (
                <section className="activity-section" aria-label="Question history">
                  <h3 className="activity-section-title">Questions</h3>
                  {questions.map((question) => (
                    <ActivityRow
                      key={question.askId}
                      id={`${domId}-ask-${question.askId}`}
                      view={questionView(question, model.pendingAsk === question.askId && !ended)}
                    />
                  ))}
                </section>
              )}
              <section className="activity-steps" aria-labelledby={`${domId}-steps`}>
                <div className="activity-steps-head">
                  <h3 id={`${domId}-steps`}>Steps</h3>
                  <SegmentedControl
                    label="Activity filter"
                    size={24}
                    items={FILTERS}
                    value={filter}
                    onChange={setFilter}
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
                  {sessionId &&
                    (headed
                      ? groups.map((group, index) => {
                          const meta = groupMeta(
                            group.entries.map(
                              (entry) =>
                                views.get(entry.key) ?? entryView(entry, model.changes, ended),
                            ),
                          );
                          const holdsOpen = group.entries.some(
                            (entry) => entry.key === openKey || entry.key === currentKey,
                          );
                          const open = groupState[group.id] ?? (index >= foldBefore || holdsOpen);
                          return (
                            <Disclosure
                              key={group.id}
                              className="activity-group"
                              data-anchor=""
                              summary={
                                (group.planItem && planText.get(group.planItem)) || "Other steps"
                              }
                              meta={[
                                count(meta.steps, "step", "steps"),
                                meta.failed ? `${meta.failed} failed` : "",
                                meta.durationMs >= 1000 ? clock(meta.durationMs) : "",
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                              open={open}
                              onClick={(event) => follow.anchorTo(event.currentTarget)}
                              onOpenChange={(next) =>
                                setGroupsOpen({
                                  owner,
                                  open: { ...groupState, [group.id]: next },
                                })
                              }
                            >
                              <div className="activity-group-rows">
                                {group.entries.map(renderEntry)}
                              </div>
                            </Disclosure>
                          );
                        })
                      : page.rows.map(renderEntry))}
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
              {agent && (
                <ResultFiles
                  api={api}
                  sessionId={sessionId}
                  results={model.results}
                  ended={ended}
                  idle={model.state?.state === "idle"}
                />
              )}
              {model.historyTruncated && (
                <p className="activity-note">Older activity is kept in the task log.</p>
              )}
            </div>
          </ScrollArea>
          {!replay && (
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
      )}
      {agent && sessionId && <UsageFooter model={model} selection={models} />}
    </aside>
  );
}
