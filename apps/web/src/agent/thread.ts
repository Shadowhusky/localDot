import type { SessionOrigin } from "@localdot/protocol";
import { microsToMs, ULID_PATTERN, ulidTime } from "@localdot/protocol";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { activityRows, type EntryView, entryView, foldKeyUses } from "./activity.ts";
import type {
  AgentMessage,
  AgentModel,
  AgentQuestion,
  AgentResult,
  AgentTakeover,
  RoutineProposal,
  SpendCall,
} from "./model.ts";

export type Speaker = "user" | "dot";
export type WorkStep = EntryView & { key: string };

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
  item.kind === "message" && item.message.role === "user" && item.message.kind !== "steer";

const startOf = (item: ThreadItem) =>
  item.kind === "message" && item.message.at !== undefined ? microsToMs(item.message.at) : null;

// Each turn that worked on the computer ends with a line of what it did. The latest turn also has one
// while the task is live, steps or not, so the thread is never silent while dot works.
export function withWork(
  items: readonly ThreadItem[],
  steps: readonly WorkStep[],
  live: boolean,
  spends: readonly SpendCall[] = [],
): ThreadItem[] {
  const turns: { key: string; start: number | null; items: ThreadItem[] }[] = [];
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
  const owned = new Map<number, WorkStep[]>();
  for (const step of steps) {
    const at = turnAt(step.startT);
    owned.set(at, [...(owned.get(at) ?? []), step]);
  }
  const spent = new Map<number, { usd: number; estimated: boolean }>();
  for (const call of spends) {
    const at = turnAt(call.atMs);
    const sum = spent.get(at) ?? { usd: 0, estimated: false };
    spent.set(at, { usd: sum.usd + call.usd, estimated: sum.estimated || call.estimated });
  }
  return turns.flatMap((turn, index) => {
    const own = owned.get(index) ?? [];
    const latest = index === turns.length - 1;
    if (!own.length && !(latest && live)) return turn.items;
    const spend = spent.get(index);
    // The line closes dot's own part of the turn: the computer changing hands after it stays after.
    let end = turn.items.length;
    while (end > 0 && turn.items[end - 1]?.kind === "control") end--;
    return [
      ...turn.items.slice(0, end),
      {
        kind: "work" as const,
        key: `work-${turn.key}`,
        speaker: "dot" as const,
        turn: turn.key,
        steps: own,
        startMs: turn.start ?? own[0]?.startT ?? null,
        ...(spend && spend.usd > 0 ? { spend } : {}),
      },
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
