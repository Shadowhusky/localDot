import { microsToMs } from "@localdot/protocol";
import { type KeyUseState, plainText } from "@localdot/stage";
import { clock as runningClock } from "../copy/format.ts";
import { type KeyUseRowView, type TimelineRow, timelineRows } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import type { IconName } from "../ui/icons.ts";
import type { GlyphState } from "../ui/StatusGlyph.tsx";
import { markdownToPlain } from "./markdown.ts";
import type { AgentChange, AgentModel, AgentStep } from "./model.ts";

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
  model?: Pick<AgentModel, "steps">,
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
  return (
    row.kind === "step" &&
    ((!!row.computer && (!row.computer.stepKind || row.computer.stepKind === "gui")) ||
      row.agent?.kind === "gui")
  );
}

export function matchesFilter(row: TimelineRow<ActivityStep>, filter: ActivityFilter): boolean {
  if (filter === "all") return true;
  return filter === "screen" ? isScreenStep(row) : !isScreenStep(row);
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

export function clock(ms: number): string {
  return runningClock(Math.round(ms / 1000));
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

const KIND_TITLES: Record<NonNullable<AgentStep["kind"]>, string> = {
  gui: "Screen step",
  shell: "Command",
  file: "Changed files",
  browser: "Browser step",
  ask: "Asked you a question",
  think: "Thinking",
  app: "Used a connected app",
};

// Where a step that dot took without the screen happened, in the place of a screen step's app.
const KIND_PLACES: Record<NonNullable<AgentStep["kind"]>, string> = {
  gui: "Screen",
  shell: "Terminal",
  file: "Files",
  browser: "Browser",
  ask: "",
  think: "",
  app: "App",
};

// The web tools run in the browser's step kind but never touch the user's browser.
const WEB_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);

// One flat row (design-v2 §10.20): what dot did, where and how, and how long it took. A failure's
// meta line says what went wrong instead.
export interface EntryView {
  testId: "step-row" | "tool-row" | "key-use" | "change-row";
  title: string;
  meta: string;
  time: string;
  state: GlyphState;
  stateLabel: string;
  // A file's glyph in place of a status.
  icon?: IconName;
  failed?: boolean;
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

const joined = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" · ");
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
// A step's time on the m:ss clock; anything that took time shows at least a second.
const stepTime = (ms: number) => clock(ms > 0 ? Math.max(ms, 1000) : 0);
const asSentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

type StepRow = Extract<TimelineRow<ActivityStep>, { kind: "step" }>;

function rowWords(row: StepRow, own: readonly AgentChange[], ended: boolean) {
  const { computer, agent } = row;
  const [state, stateLabel] =
    agent && (agent.status || !computer)
      ? agentState(agent, ended)
      : computer && !(ended && computer.status === "doing")
        ? COMPUTER_STATES[computer.status]
        : agentState({ id: row.id, output: [], outputTruncated: false }, ended);
  const kind = agent?.kind ?? computer?.stepKind ?? (computer ? "gui" : undefined);
  const what =
    computer?.label ||
    agent?.tool?.title ||
    (kind === "file" ? fileTitle(own) : "") ||
    (kind ? KIND_TITLES[kind] : "Step");
  // dot's own line for the call leads its first row; what it did moves to the meta line.
  const given = agent?.intent ?? computer?.intent;
  const intent = (given && plainText(given)) || undefined;
  const failed = state === "failed" || state === "skipped";
  const reason = failed
    ? ((agent?.note && markdownToPlain(agent.note)) ??
      computer?.reason ??
      (agent?.tool?.exitCode !== undefined ? `Exit code ${agent.tool.exitCode}` : undefined))
    : state === "todo"
      ? "The task ended before this step finished."
      : undefined;
  const distinctAction = intent && !same(intent, what) ? what : undefined;
  // A gesture says something only with what it touched: "click F3", never a bare "click".
  const touched = computer?.gesture?.includes(" ") ? computer.gesture : undefined;
  const where = computer
    ? joined(computer.app, intent ? distinctAction : touched)
    : joined(
        WEB_TOOLS.has(agent?.tool?.name ?? "") ? "Web" : kind && KIND_PLACES[kind],
        distinctAction,
        diffStat(own.map((change) => change.patch)),
      );
  return {
    state,
    stateLabel,
    kind,
    what,
    title: intent ?? what,
    reason,
    meta: reason ? asSentence(reason) : where,
    // What the meta line says dot did, unless what went wrong took its place.
    named: reason ? undefined : distinctAction,
  };
}

export function entryView(
  entry: ActivityEntry,
  changes: readonly AgentChange[],
  ended: boolean,
): EntryView {
  const { row } = entry;
  if (row.kind === "key")
    return {
      testId: "key-use",
      title: row.label,
      meta: row.blocked ? row.detail : row.count > 1 ? `${row.count} times` : "",
      time: "",
      state: row.blocked ? "failed" : "done",
      stateLabel: row.blocked ? "Blocked" : "Allowed",
      ...(row.blocked ? { failed: true } : {}),
      startT: row.t,
      endT: row.t,
    };
  const { computer, agent } = row;
  const own = changes.filter((change) => change.type === "file" && change.step === row.id);
  const words = rowWords(row, own, ended);
  const durationMs =
    computer?.durationMs ??
    (agent?.startedAt !== undefined && agent.endedAt !== undefined
      ? microsToMs(agent.endedAt - agent.startedAt)
      : null);
  return {
    testId: isScreenStep(row) ? "step-row" : "tool-row",
    title: words.title,
    meta: words.meta,
    time: durationMs === null ? "" : stepTime(durationMs),
    state: words.state,
    stateLabel: words.stateLabel,
    ...(words.reason ? { failed: true } : {}),
    startT: row.startT,
    endT: durationMs === null ? null : row.startT + durationMs,
  };
}

// What unfolding a step shows beyond its row.
export interface StepDetail {
  // What the step did, when the row leads with dot's line for it; a command or a path as typed.
  action?: { text: string; code: boolean };
  // A result note; a failure's note is the row's meta line already.
  note?: string;
  // A screen step shows its picture or says it has none; another step only a picture it took.
  frame: boolean;
  // Any output, or a command's exit code even when it printed nothing.
  output: boolean;
  changes: AgentChange[];
}

export function stepDetail(
  entry: ActivityEntry,
  changes: readonly AgentChange[],
): StepDetail | null {
  const { row } = entry;
  if (row.kind === "key") return null;
  const { computer, agent } = row;
  const own = changes.filter((change) => change.type === "file" && change.step === row.id);
  const screen = isScreenStep(row);
  // The row's words while the task runs; once it ends, only an unfinished step's meta line differs.
  const words = rowWords(row, own, false);
  const done = screen ? words.what : agent?.tool?.title;
  const said = done && [words.title, words.named].some((text) => text && same(text, done));
  const code = !screen && (words.kind === "shell" || words.kind === "file");
  return {
    ...(done && !said ? { action: { text: done, code } } : {}),
    ...(agent?.note && (agent.status === "ok" || !agent.status) ? { note: agent.note } : {}),
    frame: !!computer && (screen || !!computer.frameId),
    output:
      !!agent &&
      ((agent.images?.length ?? 0) > 0 ||
        (agent.terminal?.inputBytes ?? 0) > 0 ||
        agent.tool?.exitCode !== undefined ||
        agent.outputTruncated),
    changes: own,
  };
}

export function hasDetails(entry: ActivityEntry, changes: readonly AgentChange[]): boolean {
  const detail = stepDetail(entry, changes);
  return (
    !!detail &&
    (!!detail.action ||
      !!detail.note ||
      detail.frame ||
      detail.output ||
      detail.changes.length > 0 ||
      entry.keys.length > 0)
  );
}

export function changeView(change: AgentChange): EntryView {
  const notes = change.type === "memory" && change.path.startsWith("notes/");
  const verb =
    change.type === "memory"
      ? change.undoes
        ? notes
          ? "Daily note undone"
          : "Memory change undone"
        : notes
          ? "Added to today's notes"
          : "Memory updated"
      : change.op === "create"
        ? "Created"
        : change.op === "delete"
          ? "Deleted"
          : "Changed";
  return {
    testId: "change-row",
    icon: "file",
    title: baseName(change.path),
    meta: joined(verb, diffStat([change.patch])),
    time: "",
    state: "done",
    stateLabel: "Done",
    startT: Number.NaN,
    endT: null,
  };
}

export interface ReadGroup<T> {
  key: string;
  entries: T[];
  label?: string;
}
export type ActivityGroup = ReadGroup<ActivityEntry>;

// A group key is evidence of a successful read, scoped to its plan item. Presentation
// titles alone must never classify a mutation, failure or current action as read-only.
export function activityReadGroup(entry: ActivityEntry): string | undefined {
  const row = entry.row;
  if (row.kind !== "step") return undefined;
  const tool = row.agent?.tool;
  return (row.agent?.status ?? row.computer?.status) === "ok" &&
    tool?.ok !== false &&
    (tool?.name === "files" || row.computer?.stepKind === "file") &&
    /^(read|list) /i.test(tool?.title ?? row.computer?.label ?? "")
    ? (row.agent?.planItem ?? "")
    : undefined;
}

// Shared by Activity and Chat. Keep every audit identity and cap groups so opening one
// never introduces an unbounded block. Failures, mutations and running steps stay separate.
export function groupReadSteps<T extends { key: string }>(
  entries: readonly T[],
  readGroup: (entry: T) => string | undefined,
): ReadGroup<T>[] {
  const groups: ReadGroup<T>[] = [];
  for (const entry of entries) {
    const scope = readGroup(entry);
    const previous = groups.at(-1);
    if (
      scope !== undefined &&
      previous?.label &&
      previous.entries.length < 50 &&
      readGroup(previous.entries[0]!) === scope
    )
      previous.entries.push(entry);
    else
      groups.push({
        key: entry.key,
        entries: [entry],
        ...(scope !== undefined ? { label: "Read files and instructions" } : {}),
      });
  }
  return groups;
}
export function groupActivity(entries: readonly ActivityEntry[]): ActivityGroup[] {
  return groupReadSteps(entries, activityReadGroup);
}
