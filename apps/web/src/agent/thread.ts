import type { SessionOrigin } from "@localdot/protocol";
import { microsToMs, ULID_PATTERN, ulidTime } from "@localdot/protocol";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { activityRows, type EntryView, entryView, foldKeyUses } from "./activity.ts";
import {
  AGENT_LIMITS,
  type AgentMessage,
  type AgentModel,
  type AgentQuestion,
  type AgentResult,
  type AgentTakeover,
  type RoutineProposal,
  type SpendCall,
  type UsageCall,
} from "./model.ts";

export type Speaker = "user" | "dot";
export type WorkStep = EntryView & { key: string };
export interface ModelRef {
  readonly route: string;
  readonly model: string;
}
// A model one turn called, with the tokens its provider reported for those calls.
export interface TurnModel extends ModelRef {
  readonly role: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
}

interface Item<K extends string> {
  kind: K;
  key: string;
  speaker: Speaker;
  // Wall-clock ms, when the item's ID says.
  time?: number;
}
export type ThreadItem =
  | (Item<"message"> & { message: AgentMessage })
  | (Item<"question"> & { question: AgentQuestion })
  | (Item<"answer"> & { question: AgentQuestion })
  | (Item<"result"> & { result: AgentResult })
  // A routine dot drafted, for the user to save.
  | (Item<"routine"> & { proposal: RoutineProposal })
  // What started a task the user didn't: a routine or a follow-up.
  | (Item<"origin"> & { origin: SessionOrigin })
  // The computer changing hands: the user took it or dot handed it over (`handed`), or the user
  // handed it back, maybe saying "Not now" to dot's hand-off (`declined`).
  | (Item<"control"> & { took: boolean; at?: number; handed?: boolean; declined?: boolean })
  | (Item<"work"> & {
      turn: string;
      steps: readonly WorkStep[];
      startMs: number | null;
      // What the turn's model calls cost, when any cost something.
      spend?: { usd: number; estimated: boolean };
    })
  // A finished turn's quiet last line: the model, and what the turn's calls reported.
  | (Item<"meta"> & {
      turn: string;
      // The models the turn called, its main one first.
      models: readonly TurnModel[];
      // The task's model, when the turn's calls said nothing of theirs.
      main?: ModelRef;
      durationMs?: number;
      // What the turn's calls cost, only when the provider billed every one.
      usd?: number;
      // The turn's work line, just above, already says how long it took and what it cost.
      work: boolean;
    });

export type ThreadKind = ThreadItem["kind"];

// What the divider says where the computer changed hands.
export function controlLine(item: Extract<ThreadItem, { kind: "control" }>): string {
  if (item.took) return item.handed ? "dot handed you the computer" : "You took control";
  return item.declined ? "You said not now" : "You handed back";
}

export interface ThreadRow {
  item: ThreadItem;
  // The first item of a run by one speaker carries the speaker's name, and the run's gap above.
  groupStart: boolean;
  // A quiet time above the item: at the start, and after a long pause.
  separator: string | null;
}

const wallTime = (id: string) => (ULID_PATTERN.test(id) ? ulidTime(id) : undefined);

interface Placed {
  item: ThreadItem;
  order: number;
  index: number;
}

// Messages, questions and the answers to them, results, and the computer changing hands, in the
// order the task produced them.
export function threadItems(
  messages: Iterable<AgentMessage>,
  questions: Iterable<AgentQuestion> = [],
  results: Iterable<AgentResult> = [],
  takeovers: Iterable<AgentTakeover> = [],
  proposals: Iterable<RoutineProposal> = [],
  origin?: SessionOrigin,
): ThreadItem[] {
  const placed: Placed[] = [];
  const place = (item: ThreadItem, order: number | undefined) =>
    placed.push({ item, order: order ?? Number.NaN, index: placed.length });
  for (const message of messages)
    place(
      {
        kind: "message",
        key: `message-${message.id}`,
        speaker: message.role === "user" ? "user" : "dot",
        time: wallTime(message.id),
        message,
      },
      message.seq,
    );
  for (const question of questions) {
    place(
      {
        kind: "question",
        key: `question-${question.askId}`,
        speaker: "dot",
        time: wallTime(question.askId),
        question,
      },
      question.seq,
    );
    // The reply sits under its question, whenever it came.
    if (question.answer?.by === "user")
      place(
        { kind: "answer", key: `answer-${question.askId}`, speaker: "user", question },
        question.seq === undefined ? undefined : question.seq + 0.5,
      );
  }
  for (const result of results)
    place(
      {
        kind: "result",
        key: `result-${result.id}`,
        speaker: "dot",
        time: wallTime(result.id),
        result,
      },
      result.seq,
    );
  for (const proposal of proposals)
    place(
      {
        kind: "routine",
        key: `routine-${proposal.routineId}`,
        speaker: "dot",
        time: wallTime(proposal.id),
        proposal,
      },
      proposal.seq,
    );
  for (const takeover of takeovers) {
    // The user took it when they asked for it, or when they took the computer dot handed over.
    const took =
      takeover.by === "user" ? { seq: takeover.seq, time: takeover.time } : takeover.taken;
    if (took)
      place(
        {
          kind: "control",
          key: `took-${takeover.requestId}`,
          speaker: "user",
          at: took.time,
          took: true,
          ...(takeover.by === "user" ? {} : { handed: true }),
        },
        took.seq,
      );
    if (takeover.end?.by === "user")
      place(
        {
          kind: "control",
          key: `back-${takeover.requestId}`,
          speaker: "user",
          at: takeover.endTime,
          took: false,
          ...(takeover.end.declined ? { declined: true } : {}),
        },
        takeover.endSeq,
      );
  }
  const sorted = placed
    .sort((a, b) =>
      Number.isNaN(a.order) || Number.isNaN(b.order) ? a.index - b.index : a.order - b.order,
    )
    .map((entry) => entry.item);
  return origin
    ? [{ kind: "origin", key: `origin-${origin.runId}`, speaker: "dot", origin }, ...sorted]
    : sorted;
}

// A task's steps, as the work lines of its turns show them.
export function workSteps(
  rows: readonly TimelineRow<StepRowView>[],
  model: AgentModel,
): WorkStep[] {
  return foldKeyUses(activityRows(rows, model))
    .filter((entry) => entry.row.kind === "step")
    .map((entry) => ({ key: entry.key, ...entryView(entry, model.changes, !!model.ended) }));
}

// A turn starts at each task or follow-up the user sends; steering a running task stays in its turn.
const startsTurn = (item: ThreadItem) =>
  item.kind === "message" &&
  item.message.role === "user" &&
  item.message.kind !== "steer" &&
  !item.message.queued;

const startOf = (item: ThreadItem) =>
  item.kind === "message" && item.message.at !== undefined ? microsToMs(item.message.at) : null;

// When an item of dot's was last seen, in session ms.
function seenAt(item: ThreadItem): number | null {
  const at =
    item.kind === "message"
      ? (item.message.doneAt ?? item.message.at)
      : item.kind === "result"
        ? item.result.at
        : item.kind === "question"
          ? item.question.at
          : undefined;
  return at === undefined ? null : microsToMs(at);
}

const said = (item: ThreadItem) =>
  item.kind === "result" ||
  item.kind === "question" ||
  item.kind === "routine" ||
  (item.kind === "message" && item.message.role === "assistant");

function turnModels(calls: readonly UsageCall[]): TurnModel[] {
  const models = new Map<string, TurnModel>();
  for (const call of calls) {
    const id = `${call.role}\0${call.route}\0${call.model}`;
    const was = models.get(id);
    const reasoning =
      was?.reasoningTokens === undefined && call.reasoningTokens === undefined
        ? undefined
        : (was?.reasoningTokens ?? 0) + (call.reasoningTokens ?? 0);
    models.set(id, {
      role: call.role,
      route: call.route,
      model: call.model,
      calls: (was?.calls ?? 0) + 1,
      inputTokens: (was?.inputTokens ?? 0) + call.inputTokens,
      outputTokens: (was?.outputTokens ?? 0) + call.outputTokens,
      ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    });
  }
  const all = [...models.values()];
  return [...all.filter((row) => row.role === "main"), ...all.filter((row) => row.role !== "main")];
}

interface Turn {
  key: string;
  start: number | null;
  items: ThreadItem[];
}

// A finished turn's last line, once dot said or did something and there is a model to name.
function turnMeta(
  turn: Turn,
  own: readonly WorkStep[],
  calls: readonly UsageCall[],
  bills: readonly SpendCall[],
  billsWhole: boolean,
  main?: ModelRef,
): Extract<ThreadItem, { kind: "meta" }> | null {
  const models = turnModels(calls);
  if (!(turn.items.some(said) || own.length) || !(models.length || main)) return null;
  const ends = [
    ...turn.items.map(seenAt),
    ...own.map((step) => step.endT ?? step.startT),
    ...calls.map((call) => call.atMs),
    ...bills.map((call) => call.atMs),
  ].filter((t): t is number => t !== null);
  const last = ends.length ? Math.max(...ends) : null;
  const usd = bills.reduce((sum, call) => sum + call.usd, 0);
  const billed = usd > 0 && billsWhole && !bills.some((call) => call.estimated);
  return {
    kind: "meta",
    key: `meta-${turn.key}`,
    speaker: "dot",
    turn: turn.key,
    models,
    ...(!models.length && main ? { main } : {}),
    ...(turn.start !== null && last !== null && last >= turn.start
      ? { durationMs: last - turn.start }
      : {}),
    ...(billed ? { usd } : {}),
    work: own.length > 0,
  };
}

// Each turn that worked on the computer ends with a line of what it did. The latest turn also has one
// while the task is live, steps or not, so the thread is never silent while dot works. A finished
// turn then ends with its model and what its calls reported; `main` names the task's model when they
// said nothing.
export function withWork(
  items: readonly ThreadItem[],
  steps: readonly WorkStep[],
  live: boolean,
  spends: readonly SpendCall[] = [],
  { usage = [], main }: { usage?: readonly UsageCall[]; main?: ModelRef } = {},
): ThreadItem[] {
  const turns: Turn[] = [];
  for (const item of items) {
    const turn = turns.at(-1);
    if (startsTurn(item) || !turn)
      turns.push({
        key: startsTurn(item) ? item.key : "start",
        start: startOf(item),
        items: [item],
      });
    else turn.items.push(item);
  }
  if (!turns.length) turns.push({ key: "start", start: null, items: [] });
  const turnAt = (t: number) => {
    let at = 0;
    for (let i = 1; i < turns.length; i++) {
      const start = turns[i]?.start;
      if (start !== null && start !== undefined && t >= start) at = i;
    }
    return at;
  };
  const byTurn = <T>(rows: readonly T[], time: (row: T) => number) => {
    const turned = new Map<number, T[]>();
    for (const row of rows) {
      const at = turnAt(time(row));
      const own = turned.get(at);
      if (own) own.push(row);
      else turned.set(at, [row]);
    }
    return turned;
  };
  const owned = byTurn(steps, (step) => step.startT);
  const charged = byTurn(spends, (call) => call.atMs);
  const called = byTurn(usage, (call) => call.atMs);
  // A full list may have lost its oldest calls: a turn from before them has no whole count.
  const counted = (start: number | null, calls: readonly { atMs: number }[], limit: number) =>
    calls.length < limit || (start !== null && start >= (calls[0]?.atMs ?? 0));
  return turns.flatMap((turn, index) => {
    const own = owned.get(index) ?? [];
    const latest = index === turns.length - 1;
    const open = latest && live;
    const bills = charged.get(index) ?? [];
    const usd = bills.reduce((sum, call) => sum + call.usd, 0);
    const work = own.length > 0 || open;
    // The lines close dot's own part of the turn: the computer changing hands after it stays after.
    let end = turn.items.length;
    while (end > 0 && turn.items[end - 1]?.kind === "control") end--;
    const calls = counted(turn.start, usage, AGENT_LIMITS.usageCalls)
      ? (called.get(index) ?? [])
      : [];
    const meta = open
      ? null
      : turnMeta(
          turn,
          own,
          calls,
          bills,
          counted(turn.start, spends, AGENT_LIMITS.spendCalls),
          main,
        );
    if (!work && !meta) return turn.items;
    const estimated = bills.some((call) => call.estimated);
    return [
      ...turn.items.slice(0, end),
      ...(work
        ? [
            {
              kind: "work" as const,
              key: `work-${turn.key}`,
              speaker: "dot" as const,
              turn: turn.key,
              steps: own,
              startMs: turn.start ?? own[0]?.startT ?? null,
              ...(usd > 0 ? { spend: { usd, estimated } } : {}),
            },
          ]
        : []),
      ...(meta ? [meta] : []),
      ...turn.items.slice(end),
    ];
  });
}

const PAUSE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export function timeLabel(time: number, now = Date.now()): string {
  const at = new Date(time);
  const clock = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return clock;
  if (now - time < 6 * DAY_MS)
    return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${clock}`;
  return `${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${clock}`;
}

export function threadRows(items: readonly ThreadItem[], now = Date.now()): ThreadRow[] {
  let last: number | undefined;
  return items.map((item, index) => {
    const before = items[index - 1];
    const time = item.time;
    const separator =
      time !== undefined && (last === undefined || time - last >= PAUSE_MS)
        ? timeLabel(time, now)
        : null;
    if (time !== undefined) last = time;
    return {
      item,
      groupStart: !before || before.speaker !== item.speaker || separator !== null,
      separator,
    };
  });
}
