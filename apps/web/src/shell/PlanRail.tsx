import type { TaskModelSelection } from "@localdot/protocol";
import type { KeyUseState, PlanItemState } from "@localdot/stage";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityDetails, type InspectOutput } from "../agent/ActivityDetails.tsx";
import {
  type ActivityFilter,
  type ActivityStep,
  activityRows,
  matchesFilter,
  stepStatus,
} from "../agent/activity.ts";
import { HistoryPages } from "../agent/HistoryPages.tsx";
import { MemoryCard, type UndoStatus } from "../agent/MemoryCard.tsx";
import { type AgentChange, type AgentModel, emptyAgentModel } from "../agent/model.ts";
import { PlanView } from "../agent/PlanView.tsx";
import { QuestionCard } from "../agent/QuestionCard.tsx";
import { ResultCard } from "../agent/ResultCard.tsx";
import { ResultFiles } from "../agent/ResultFiles.tsx";
import { type SkillSummary, SkillsView } from "../agent/SkillsView.tsx";
import { ToolRow } from "../agent/ToolRow.tsx";
import { UsageView } from "../agent/UsageView.tsx";
import { usePagedRows } from "../agent/usePagedRows.ts";
import { BrowserDownloads } from "../browser/BrowserDownloads.tsx";
import type { ApiClient } from "../lib/api.ts";
import { timeLabel } from "../replay/replay-view.ts";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { KeyUseRow } from "./KeyUseRow.tsx";
import { StepRow } from "./StepRow.tsx";
import "../agent/activity.css";

export interface PlanRailProps {
  rows: TimelineRow<StepRowView>[];
  keyUses?: readonly KeyUseState[];
  sessionId: string | null;
  cellId?: string;
  releaseReady?: boolean;
  scale: number;
  api: ApiClient;
  title: string | null;
  asOfMs?: number;
  onSelect?(stepId: string): void;
  planSnapshot?: PlanItemState[];
  agent?: AgentModel;
  skills?: readonly SkillSummary[];
  models?: TaskModelSelection;
  knowledge?: ReactNode;
  memoryAction?: (change: AgentChange) => {
    status?: UndoStatus;
    onUndo?: (changeId: string) => void;
    onReread?: () => void;
  };
}

const timelineKey = (row: TimelineRow<ActivityStep>) => `${row.kind}-${row.id}`;

export function PlanRail({
  rows,
  keyUses,
  sessionId,
  cellId,
  releaseReady = false,
  scale,
  api,
  title,
  agent,
  skills,
  memoryAction,
  models,
  knowledge,
  asOfMs,
  onSelect,
  planSnapshot,
}: PlanRailProps) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const model = agent ?? emptyAgentModel();
  const timeline = activityRows(rows, agent, keyUses);
  const lastStep = timeline.findLastIndex((row) => row.kind === "step");
  const selected = timeline.filter((row) => matchesFilter(row, filter));
  const page = usePagedRows(selected, timelineKey, `${sessionId ?? ""}:${filter}`);
  const stepPane = useRef<HTMLElement>(null);
  useEffect(() => {
    const preserveSelection = () => {
      const selection = window.getSelection(),
        pane = stepPane.current;
      if (!pane || !selection || selection.isCollapsed || !selection.rangeCount) return;
      if (selection.getRangeAt(0).intersectsNode(pane)) page.freeze();
    };
    document.addEventListener("selectionchange", preserveSelection);
    return () => document.removeEventListener("selectionchange", preserveSelection);
  }, [page.freeze]);
  const inspectChanges = (changes: readonly AgentChange[], inspect: InspectOutput) =>
    changes.map((change) => (
      <button
        type="button"
        key={change.id}
        onClick={(event) => inspect("diff", change.id, event.currentTarget)}
      >
        Inspect {change.op ?? "change"}: {change.path}
      </button>
    ));
  return (
    <aside
      className="rail r"
      aria-label="Plan and steps"
      onScroll={(event) => {
        const pane = event.currentTarget;
        if (pane.scrollHeight - pane.clientHeight - pane.scrollTop >= 32) page.freeze();
      }}
    >
      <div className="rail-h">
        <h2>Activity</h2>
        {asOfMs !== undefined && <span>As of {timeLabel(asOfMs)}</span>}
      </div>
      {planSnapshot ? (
        <ol className="task-plan" aria-label="Plan at replay time">
          {planSnapshot.map((item) => (
            <li key={item.id} className={`plan-${item.status}`}>
              <span className="plan-state">{item.status}</span>
              {item.text}
            </li>
          ))}
        </ol>
      ) : model.plan.length ? (
        <PlanView plan={model.plan} />
      ) : (
        <p className="say empty">{title ?? "No plan yet."}</p>
      )}
      {agent && <UsageView model={model} selection={models} />}
      {cellId && asOfMs === undefined && (
        <BrowserDownloads key={cellId} api={api} cellId={cellId} releaseReady={releaseReady} />
      )}
      {agent && (
        <ResultFiles
          api={api}
          sessionId={sessionId}
          results={model.results}
          renderResult={(result, files) => (
            <ResultCard
              result={result}
              latest={result.id === model.results.at(-1)?.id}
              ended={!!model.ended}
              idle={model.state?.state === "idle"}
            >
              {files}
            </ResultCard>
          )}
        />
      )}
      <ActivityDetails model={model} sessionId={sessionId}>
        {(inspect) => (
          <>
            <div className="activity-heading">
              <h3>Steps</h3>
              {sessionId && <span>Recorded activity</span>}
            </div>
            <fieldset className="activity-filters" aria-label="Activity filter">
              {(
                [
                  ["all", "All"],
                  ["computer", "Computer"],
                  ["tools", "Tools"],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </fieldset>
            {sessionId && selected.length ? (
              <section
                ref={stepPane}
                className="steps"
                aria-label="Recorded steps"
                onPointerDownCapture={() => page.freeze()}
              >
                {page.rows.map((row) => {
                  if (row.kind === "key") return <KeyUseRow key={`key-${row.id}`} row={row} />;
                  const step = row.agent;
                  const changes = model.changes.filter(
                    (change) => change.type === "file" && change.step === row.id,
                  );
                  const controls = (
                    <>
                      {step && (step.tool || step.terminal || step.outputTruncated) && (
                        <button
                          type="button"
                          onClick={(event) => inspect("terminal", step.id, event.currentTarget)}
                        >
                          Inspect {step.tool?.title ?? "command output"}
                        </button>
                      )}
                      {inspectChanges(changes, inspect)}
                    </>
                  );
                  return row.computer ? (
                    <StepRow
                      key={`step-${row.id}`}
                      row={row.computer}
                      sessionId={sessionId}
                      scale={scale}
                      api={api}
                      current={
                        asOfMs === undefined
                          ? timeline[lastStep]?.id === row.id && row.computer.status === "doing"
                          : timeline.findLast(
                              (item) =>
                                item.kind === "step" &&
                                item.computer &&
                                item.computer.startT <= asOfMs,
                            )?.id === row.id
                      }
                      future={asOfMs !== undefined && row.computer.startT > asOfMs}
                      onSelect={onSelect}
                      thumb={asOfMs !== undefined ? "replay" : "live"}
                    >
                      {step && (
                        <p className="step-reason">
                          Step: {stepStatus(step, !!model.ended)}
                          {step.note ? ` · ${step.note}` : ""}
                        </p>
                      )}
                      {controls}
                    </StepRow>
                  ) : step ? (
                    <ToolRow key={`step-${row.id}`} step={step} ended={!!model.ended}>
                      {controls}
                    </ToolRow>
                  ) : null;
                })}
                <HistoryPages
                  label="steps"
                  older={page.hasOlder}
                  newer={page.hasNewer}
                  onOlder={page.older}
                  onNewer={page.newer}
                />
                {page.retained && (
                  <p className="history-note">
                    This page is retained while live activity advances.
                  </p>
                )}
              </section>
            ) : (
              <p className="say empty">
                {!sessionId || !timeline.length
                  ? "Steps appear here as dot works."
                  : "No steps match this filter."}
              </p>
            )}
            {!!model.changes.length && (
              <section className="activity-changes" aria-label="Change previews">
                <h3>Changes</h3>
                {model.changes
                  .filter(
                    (change) =>
                      change.type === "memory" ||
                      !change.step ||
                      !timeline.some((row) => row.kind === "step" && row.id === change.step),
                  )
                  .map((change) =>
                    change.type === "memory" ? (
                      <MemoryCard
                        key={change.id}
                        change={change}
                        changes={model.changes}
                        onInspect={(trigger) => inspect("diff", change.id, trigger)}
                        {...memoryAction?.(change)}
                      />
                    ) : (
                      inspectChanges([change], inspect)
                    ),
                  )}
              </section>
            )}
            {!!model.questions.size && (
              <section className="question-history" aria-label="Question history">
                {[...model.questions.values()].map((question) => (
                  <QuestionCard
                    key={question.askId}
                    question={question}
                    pending={model.pendingAsk === question.askId && !model.ended}
                  />
                ))}
              </section>
            )}
            {model.historyTruncated && (
              <p className="history-note">
                Showing retained activity. Earlier entries remain in the task log.
              </p>
            )}
          </>
        )}
      </ActivityDetails>
      {skills && <SkillsView skills={skills} />}
      {knowledge}
    </aside>
  );
}
