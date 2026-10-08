import { microsToMs, msToSeconds } from "@localdot/protocol";
import type { KeyUseState } from "@localdot/stage";
import { type KeyUseRowView, type TimelineRow, timelineRows } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import type { IconName } from "../ui/icons.ts";
import type { GlyphState } from "../ui/StatusGlyph.tsx";
import type { AgentChange, AgentModel, AgentQuestion, AgentStep } from "./model.ts";

export type ActivityFilter = "all" | "screen" | "tools";
export interface ActivityStep {
  id: string;
  startT: number;
  computer?: StepRowView;
  agent?: AgentStep;
}

// Both event projections describe the same GUI step. Join by envelope ID, never by title.
// The raw audit events allow grouping only after tools have joined the ordered history.
export function activityRows(
  rows: readonly TimelineRow<StepRowView>[],
  model?: AgentModel,
  keyUses?: readonly KeyUseState[],
): TimelineRow<ActivityStep>[] {
  const steps = new Map<string, ActivityStep>();
  for (const row of rows) {
    if (row.kind === "step")
      steps.set(row.id, {
        id: row.id,
        startT: row.startT,
        computer: row,
        agent: model?.steps.get(row.id),
      });
  }
  for (const row of model?.steps.values() ?? []) {
    if (steps.has(row.id)) continue;
    const at = row.startedAt ?? row.firstSeenAt;
    steps.set(row.id, {
      id: row.id,
      startT: at === undefined ? Number.POSITIVE_INFINITY : microsToMs(at),
      agent: row,
    });
  }
  if (keyUses) return timelineRows([...steps.values()], keyUses);
  return [
    ...[...steps.values()].map((row) => ({ ...row, kind: "step" as const })),
    ...rows.filter((row) => row.kind === "key"),
  ].sort((a, b) => (a.kind === "key" ? a.t : a.startT) - (b.kind === "key" ? b.t : b.startT));
}

export interface ActivityEntry {
  key: string;
  row: TimelineRow<ActivityStep>;
  // Allowed key uses folded into this step: every model call uses one, so as rows they drown it.
  keys: KeyUseRowView[];
}

// An allowed use joins the step before it, or the first step after when none came before. A blocked
// use is an exception the reader must see, so it keeps its own row.
export function foldKeyUses(rows: readonly TimelineRow<ActivityStep>[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  let early: KeyUseRowView[] = [];
  let last: ActivityEntry | undefined;
  for (const row of rows) {
    if (row.kind === "key" && !row.blocked) {
      if (last) last.keys.push(row);
      else early.push(row);
      continue;
    }
    const entry: ActivityEntry = { key: `${row.kind}-${row.id}`, row, keys: [] };
    if (row.kind === "step") {
      entry.keys = early;
      early = [];
      last = entry;
    }
    entries.push(entry);
  }
  for (const row of early) entries.push({ key: `key-${row.id}`, row, keys: [] });
  return entries;
}

export function isScreenStep(row: TimelineRow<ActivityStep>): boolean {
  return row.kind === "step" && (!!row.computer || row.agent?.kind === "gui");
}

export function matchesFilter(row: TimelineRow<ActivityStep>, filter: ActivityFilter): boolean {
  if (filter === "all") return true;
  return filter === "screen" ? isScreenStep(row) : !isScreenStep(row);
}

export interface ActivityGroup {
  id: string;
  planItem: string | null;
  entries: ActivityEntry[];
}

const planItemOf = (entry: ActivityEntry) =>
  entry.row.kind === "step" ? (entry.row.agent?.planItem ?? null) : null;

// Consecutive runs under one plan item. A row without one stays in the run it arrived in, and rows
// from before the first planned step open that step's run. A return to an earlier item starts a new
// run, so time order is kept.
export function groupEntries(entries: readonly ActivityEntry[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  const runs = new Map<string, number>();
  let lead: ActivityEntry[] = [];
  for (const entry of entries) {
    const item = planItemOf(entry);
    const current = groups.at(-1);
    if (item === null) {
      if (current) current.entries.push(entry);
      else lead.push(entry);
      continue;
    }
    if (current?.planItem === item) {
      current.entries.push(entry);
      continue;
    }
    const run = runs.get(item) ?? 0;
    runs.set(item, run + 1);
    groups.push({ id: `${item}#${run}`, planItem: item, entries: [...lead, entry] });
    lead = [];
  }
  if (lead.length) groups.push({ id: "none#0", planItem: null, entries: lead });
  return groups;
}

// Runs come from the whole history, so a filter or a page never moves a row into the run that
// happens to precede it on view.
export function runsOnView(
  runs: readonly ActivityGroup[],
  rows: readonly ActivityEntry[],
): ActivityGroup[] {
  const runOf = new Map<string, ActivityGroup>();
  for (const run of runs) for (const entry of run.entries) runOf.set(entry.key, run);
  const shown: ActivityGroup[] = [];
  for (const entry of rows) {
    const run = runOf.get(entry.key) ?? { id: "none#0", planItem: null };
    const last = shown.at(-1);
    if (last?.id === run.id) last.entries.push(entry);
    else shown.push({ id: run.id, planItem: run.planItem, entries: [entry] });
  }
  return shown;
}

export function stepStatus(step: AgentStep, ended: boolean): string {
  if (step.status)
    return { ok: "Done", failed: "Failed", blocked: "Blocked", cancelled: "Cancelled" }[
      step.status
    ];
  return ended ? "Not confirmed" : "Running";
}

export function memoryUndoEligible(change: AgentChange, changes: readonly AgentChange[]): boolean {
  return (
    change.type === "memory" &&
    !!change.changeId &&
    !change.undoes &&
    !changes.some((row) => row.type === "memory" && row.undoes === change.changeId)
  );
}

export function seconds(ms: number): string {
  return ms < 60_000 ? `${msToSeconds(ms).toFixed(1)} s` : clock(ms);
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function diffStat(patches: readonly (string | undefined)[]): string {
  let added = 0,
    removed = 0;
  for (const patch of patches)
    for (const line of patch?.split("\n") ?? []) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
  return [added && `+${added}`, removed && `−${removed}`].filter(Boolean).join(" ");
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

const KIND_ICONS: Record<NonNullable<AgentStep["kind"]>, IconName> = {
  gui: "mouse-pointer-click",
  shell: "terminal",
  file: "file-diff",
  browser: "globe",
  ask: "circle-alert",
  think: "more-horizontal",
};

const KIND_TITLES: Record<NonNullable<AgentStep["kind"]>, string> = {
  gui: "Screen step",
  shell: "Command",
  file: "Changed files",
  browser: "Browser step",
  ask: "Asked you a question",
  think: "Thinking",
};

const VERB_ICONS: Record<string, IconName> = {
  type: "type",
  key: "keyboard",
  scroll: "arrow-down",
  wait: "more-horizontal",
};

export interface EntryView {
  testId: "step-row" | "tool-row" | "key-use" | "change-row" | "question-row";
  icon: IconName;
  title: string;
  metric: string;
  state: GlyphState;
  stateLabel: string;
  reason?: string;
  notSent?: boolean;
  danger?: boolean;
  startT: number;
  endT: number | null;
}

function fileTitle(changes: readonly AgentChange[]): string {
  const [only] = changes;
  if (changes.length !== 1 || !only) return changes.length ? `Changed ${changes.length} files` : "";
  const verb = only.op === "create" ? "Created" : only.op === "delete" ? "Deleted" : "Changed";
  return `${verb} ${baseName(only.path)}`;
}

function agentState(step: AgentStep, ended: boolean): [GlyphState, string] {
  if (step.status === "ok") return ["done", "Done"];
  if (step.status === "failed") return ["failed", "Failed"];
  if (step.status === "blocked") return ["failed", "Blocked"];
  if (step.status === "cancelled") return ["skipped", "Cancelled"];
  return ended ? ["todo", "Not confirmed"] : ["doing", "Running"];
}

const COMPUTER_STATES: Record<StepRowView["status"], [GlyphState, string]> = {
  doing: ["doing", "Running"],
  ok: ["done", "Done"],
  failed: ["failed", "Failed"],
  cancelled: ["skipped", "Cancelled"],
};

export function entryView(
  entry: ActivityEntry,
  changes: readonly AgentChange[],
  ended: boolean,
): EntryView {
  const { row } = entry;
  if (row.kind === "key")
    return {
      testId: "key-use",
      icon: row.blocked ? "lock" : "key-round",
      title: row.label,
      metric: row.count > 1 ? `×${row.count}` : "",
      state: row.blocked ? "failed" : "done",
      stateLabel: row.blocked ? "Blocked" : "Allowed",
      ...(row.blocked ? { reason: row.detail, danger: true } : {}),
      startT: row.t,
      endT: row.t,
    };
  const { computer, agent } = row;
  const own = changes.filter((change) => change.type === "file" && change.step === row.id);
  const [state, stateLabel] =
    agent && (agent.status || !computer)
      ? agentState(agent, ended)
      : computer && !(ended && computer.status === "doing")
        ? COMPUTER_STATES[computer.status]
        : agentState({ id: row.id, output: [], outputTruncated: false }, ended);
  const kind = agent?.kind ?? (computer ? "gui" : undefined);
  const durationMs =
    computer?.durationMs ??
    (agent?.startedAt !== undefined && agent.endedAt !== undefined
      ? microsToMs(agent.endedAt - agent.startedAt)
      : null);
  const title =
    computer?.label ||
    agent?.tool?.title ||
    (kind === "file" ? fileTitle(own) : "") ||
    (kind ? KIND_TITLES[kind] : "Step");
  const failed = state === "failed" || state === "skipped";
  const reason = failed
    ? (agent?.note ??
      computer?.reason ??
      (agent?.tool?.exitCode !== undefined ? `Exit code ${agent.tool.exitCode}` : undefined))
    : state === "todo"
      ? "The task ended before this step finished."
      : undefined;
  return {
    testId: computer ? "step-row" : "tool-row",
    icon:
      (computer?.verb && VERB_ICONS[computer.verb]) ||
      (kind ? KIND_ICONS[kind] : "more-horizontal"),
    title,
    metric: own.length
      ? diffStat(own.map((change) => change.patch))
      : durationMs === null
        ? ""
        : seconds(durationMs),
    state,
    stateLabel,
    ...(reason ? { reason } : {}),
    ...(failed && computer?.delivery === "proposed" ? { notSent: true } : {}),
    startT: row.startT,
    endT: durationMs === null ? null : row.startT + durationMs,
  };
}

export function hasDetails(entry: ActivityEntry, changes: readonly AgentChange[]): boolean {
  const { row } = entry;
  if (row.kind === "key") return false;
  return (
    !!row.computer ||
    entry.keys.length > 0 ||
    (!!row.agent?.note && (row.agent.status === "ok" || !row.agent.status)) ||
    !!(row.agent && (row.agent.tool || row.agent.terminal || row.agent.outputTruncated)) ||
    changes.some((change) => change.type === "file" && change.step === row.id)
  );
}

export interface GroupMeta {
  steps: number;
  failed: number;
  durationMs: number;
}

export function groupMeta(views: readonly EntryView[]): GroupMeta {
  const starts = views.map((view) => view.startT).filter(Number.isFinite);
  const ends = views.map((view) => view.endT ?? view.startT).filter(Number.isFinite);
  const steps = views.filter((view) => view.testId !== "key-use");
  return {
    steps: steps.length,
    failed: steps.filter((view) => view.state === "failed").length,
    durationMs: starts.length ? Math.max(...ends) - Math.min(...starts) : 0,
  };
}

export function questionView(question: AgentQuestion, waiting: boolean): EntryView {
  const answer = question.answer;
  const option = question.options.find((item) => item.key === answer?.option);
  const [state, stateLabel]: [GlyphState, string] = !answer
    ? waiting
      ? ["doing", "Waiting for you"]
      : ["skipped", "No longer waiting"]
    : answer.by === "stop"
      ? ["skipped", "Stopped"]
      : answer.by === "timeout"
        ? ["skipped", "Timed out"]
        : ["done", "Answered"];
  const reason = [
    option ? `Answer: ${option.text}` : answer?.option ? `Answer: ${answer.option}` : "",
    answer?.text ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    testId: "question-row",
    icon: "circle-alert",
    title: question.question,
    metric: "",
    state,
    stateLabel,
    ...(reason ? { reason } : {}),
    startT: Number.NaN,
    endT: null,
  };
}

export function changeView(change: AgentChange): EntryView {
  const verb =
    change.type === "memory"
      ? change.undoes
        ? "Undid a memory change in"
        : "Updated memory in"
      : change.op === "create"
        ? "Created"
        : change.op === "delete"
          ? "Deleted"
          : "Changed";
  return {
    testId: "change-row",
    icon: change.type === "memory" ? "file" : "file-diff",
    title: `${verb} ${baseName(change.path)}`,
    metric: diffStat([change.patch]),
    state: "done",
    stateLabel: "Done",
    startT: Number.NaN,
    endT: null,
  };
}
