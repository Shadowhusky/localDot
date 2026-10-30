import type { PremiumSpeed, SessionOrigin } from "@localdot/protocol";
import { microsToMs, ULID_PATTERN, ulidTime } from "@localdot/protocol";
import type { KeyUseRowView, TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import {
  type ActivityEntry,
  activityReadGroup,
  activityRows,
  type EntryView,
  entryView,
  foldKeyUses,
} from "./activity.ts";
import {
  AGENT_LIMITS,
  type AgentChange,
  type AgentDotChoice,
  type AgentMessage,
  type AgentModel,
  type AgentQuestion,
  type AgentResult,
  type AgentTakeover,
  fastest,
  type RoutineProposal,
  type SpendCall,
  type UsageCall,
} from "./model.ts";

export type Speaker = "user" | "dot";
// A step as a work line shows it, with the step itself and the changes it made for its details.
export type WorkStep = EntryView & {
  key: string;
  readGroup?: string;
  entry: ActivityEntry;
  changes: readonly AgentChange[];
};
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
  // The fastest premium speed that served any of those calls.
  readonly speed?: PremiumSpeed;
}

interface Item<K extends string> {
  kind: K;
  key: string;
  speaker: Speaker;
  // Wall-clock ms, when the item's ID says.
  time?: number;
  // Session ms it happened at, which places the steps taken around it.
  atMs?: number;
}
export type ThreadItem =
  // `narration`: dot's words before more of its work in the turn, rather than its answer.
  | (Item<"message"> & { message: AgentMessage; narration?: true })
  | (Item<"question"> & { question: AgentQuestion })
  | (Item<"answer"> & { question: AgentQuestion })
  | (Item<"result"> & { result: AgentResult })
  // A routine dot drafted, for the user to save.
  | (Item<"routine"> & { proposal: RoutineProposal })
  // What started a task the user didn't: a routine or a follow-up.
  | (Item<"origin"> & { origin: SessionOrigin })
  // The dot the conversation works as, when Auto picked it or the user switched.
  | (Item<"dot"> & { choice: AgentDotChoice })
  // The computer changing hands: the user took it or dot handed it over (`handed`), or the user
  // handed it back, maybe saying "Not now" to dot's hand-off (`declined`).
  | (Item<"control"> & { took: boolean; at?: number; handed?: boolean; declined?: boolean })
  // The steps dot took between two things it said, or since the last while it works.
  | (Item<"work"> & {
      turn: string;
      steps: readonly WorkStep[];
      startMs: number | null;
      // An earlier task's turn: the task its steps were recorded in.
      sessionId?: string;
      // What the turn's model calls cost, when any cost something; on the turn's last steps.
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
      estimated?: boolean;
      // Steps sit just above the line.
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
const sessionMs = (micros: number | undefined) =>
  micros === undefined ? undefined : microsToMs(micros);

// A message the user took back to edit, or cancelled, or that Stop left unanswered, was never said
// to dot.
const unsent = (message: AgentMessage) =>
  message.delivery === "withdrawn" || message.delivery === "cancelled";
// Only one Stop left unsent stays in the thread, for the user to take back; one taken back, by
// Edit or by Stop, has left it.
const dropped = (message: AgentMessage) =>
  message.delivery === "withdrawn" || (unsent(message) && !message.stopped);

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
  dots: Iterable<AgentDotChoice> = [],
): ThreadItem[] {
  const placed: Placed[] = [];
  const place = (item: ThreadItem, order: number | undefined) =>
    placed.push({ item, order: order ?? Number.NaN, index: placed.length });
  for (const message of messages)
    if (!dropped(message))
      place(
        {
          kind: "message",
          key: `message-${message.id}`,
          speaker: message.role === "user" ? "user" : "dot",
          time: message.time ?? wallTime(message.id),
          atMs: sessionMs(message.at),
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
        atMs: sessionMs(question.at),
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
        atMs: sessionMs(result.at),
        result,
      },
      result.seq,
    );
  for (const choice of dots)
    place(
      { kind: "dot", key: `dot-${choice.id}`, speaker: "dot", time: wallTime(choice.id), choice },
      choice.seq,
    );
  for (const proposal of proposals)
    place(
      {
        kind: "routine",
        key: `routine-${proposal.routineId}`,
        speaker: "dot",
        time: wallTime(proposal.id),
        atMs: sessionMs(proposal.at),
        proposal,
      },
      proposal.seq,
    );
  for (const takeover of takeovers) {
    // The user took it when they asked for it, or when they took the computer dot handed over.
    const took =
      takeover.by === "user"
        ? { seq: takeover.seq, time: takeover.time, at: takeover.at }
        : takeover.taken;
    if (took)
      place(
        {
          kind: "control",
          key: `took-${takeover.requestId}`,
          speaker: "user",
          at: took.time,
          atMs: sessionMs(took.at),
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
          atMs: sessionMs(takeover.endAt),
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

// The work steps last drawn for one thread, by key, with what each was built from: a step whose
// row, key uses, file changes and ending are the same is not built again.
export type WorkStepCache = Map<
  string,
  {
    row: object;
    keys: readonly KeyUseRowView[];
    changes: readonly AgentChange[];
    ended: boolean;
    step: WorkStep;
  }
>;
const NO_CHANGES: readonly AgentChange[] = [];
// Key uses fold into the step before them after its row is drawn, and a run of them grows in place.
const sameKeys = (was: readonly KeyUseRowView[], now: readonly KeyUseRowView[]) =>
  was.length === now.length &&
  was.every((key, index) => key.id === now[index]?.id && key.count === now[index]?.count);

// A task's steps, as the work lines of its turns show them.
export function workSteps(
  rows: readonly TimelineRow<StepRowView>[],
  model: AgentModel,
  cache?: WorkStepCache,
): WorkStep[] {
  const changes = new Map<string, AgentChange[]>();
  for (const change of model.changes) {
    if (!change.step) continue;
    const own = changes.get(change.step) ?? [];
    own.push(change);
    changes.set(change.step, own);
  }
  const ended = !!model.ended;
  const built: WorkStepCache = new Map();
  const steps = foldKeyUses(activityRows(rows, model))
    .filter((entry) => entry.row.kind === "step")
    .map((entry) => {
      const own = changes.get(entry.row.id) ?? NO_CHANGES;
      const kept = cache?.get(entry.key);
      const step =
        kept &&
        kept.row === entry.row &&
        sameKeys(kept.keys, entry.keys) &&
        kept.ended === ended &&
        kept.changes.length === own.length &&
        kept.changes.every((change, index) => change === own[index])
          ? kept.step
          : {
              key: entry.key,
              readGroup: activityReadGroup(entry),
              entry,
              changes: own,
              ...entryView(entry, own, ended),
            };
      built.set(entry.key, { row: entry.row, keys: entry.keys, changes: own, ended, step });
      return step;
    });
  if (cache) {
    cache.clear();
    for (const [key, value] of built) cache.set(key, value);
  }
  return steps;
}

// A turn starts at each task or follow-up dot receives; steering a running task stays in its turn.
const startsTurn = (item: ThreadItem) =>
  item.kind === "message" &&
  item.message.role === "user" &&
  item.message.kind !== "steer" &&
  !item.message.queued &&
  !unsent(item.message);

const trails = (item: ThreadItem | undefined) =>
  item?.kind === "control" || (item?.kind === "message" && !!item.message.stopped);

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
    const speed = fastest(was?.speed, call.speed);
    models.set(id, {
      role: call.role,
      route: call.route,
      model: call.model,
      calls: (was?.calls ?? 0) + 1,
      inputTokens: (was?.inputTokens ?? 0) + call.inputTokens,
      outputTokens: (was?.outputTokens ?? 0) + call.outputTokens,
      ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
      ...(speed ? { speed } : {}),
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
  const billed = usd > 0 && billsWhole;
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
    ...(billed
      ? { usd, ...(bills.some((call) => call.estimated) ? { estimated: true } : {}) }
      : {}),
    work: false,
  };
}

type WorkItem = Extract<ThreadItem, { kind: "work" }>;

// A message waiting for the task to finish is drawn at the end of the thread, and one that never
// reached dot not at all: neither splits the steps dot takes meanwhile.
const waits = (item: ThreadItem) =>
  item.kind === "message" && (!!item.message.queued || dropped(item.message));

// A turn as it happened: what was said and handed over, and between them each run of steps dot took,
// after the item it followed. While the turn is live it ends with a run, empty until dot takes a step,
// so the thread is never silent while dot works.
function interleave(turn: Turn, own: readonly WorkStep[], open: boolean): ThreadItem[] {
  const placed: ThreadItem[] = [];
  let after: ThreadItem | undefined;
  let run: WorkStep[] | null = null;
  let held: ThreadItem[] = [];
  let clock = Number.NEGATIVE_INFINITY;
  let next = 0;
  // The steps before `until`, or all that are left.
  const take = (until?: number) => {
    const from = next;
    while (next < own.length && (until === undefined || (own[next]?.startT ?? until) < until))
      next++;
    if (next > from) run = [...(run ?? []), ...own.slice(from, next)];
  };
  const close = () => {
    if (run)
      placed.push({
        kind: "work",
        key: `work-${after?.key ?? turn.key}`,
        speaker: "dot",
        turn: turn.key,
        steps: run,
        startMs: (after && (seenAt(after) ?? after.atMs)) ?? run[0]?.startT ?? null,
      });
    run = null;
    placed.push(...held);
    held = [];
  };
  for (const item of turn.items) {
    clock = Math.max(clock, item.atMs ?? clock);
    take(clock);
    if (waits(item) && run) held.push(item);
    else if (waits(item)) placed.push(item);
    else {
      close();
      placed.push(item);
      after = item;
    }
  }
  take();
  if (open) run ??= [];
  close();
  return placed;
}

// dot's words before more steps in their turn narrate its work; the words after its last steps are
// its answer.
function narrated(items: ThreadItem[]): ThreadItem[] {
  let worked = false;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.kind === "work" && item.steps.length) worked = true;
    else if (worked && item?.kind === "message" && item.message.role === "assistant")
      items[index] = { ...item, narration: true };
  }
  return items;
}

// Each turn shows its steps where dot took them, between what it said. A finished turn then ends with
// its model and what its calls reported; `main` names the task's model when they said nothing.
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
    const open = live && index === turns.length - 1;
    const bills = charged.get(index) ?? [];
    const usd = bills.reduce((sum, call) => sum + call.usd, 0);
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
    if (!own.length && !open && !meta) return turn.items;
    const placed = narrated(interleave(turn, own, open));
    const last = placed.findLastIndex((item) => item.kind === "work");
    const work = placed[last] as WorkItem | undefined;
    // The run dot is at counts the whole turn, as the task's own clock does.
    if (work && (usd > 0 || open))
      placed[last] = {
        ...work,
        ...(open && turn.start !== null ? { startMs: turn.start } : {}),
        ...(usd > 0 ? { spend: { usd, estimated: bills.some((call) => call.estimated) } } : {}),
      };
    if (!meta) return placed;
    // The line closes dot's own part of the turn: the computer changing hands after it, and a message
    // Stop left unsent, stay after.
    let end = placed.length;
    while (end > 0 && trails(placed[end - 1])) end--;
    return [
      ...placed.slice(0, end),
      { ...meta, work: placed[end - 1]?.kind === "work" },
      ...placed.slice(end),
    ];
  });
}

const PAUSE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

// Made once: a formatter costs far more to make than to use, and the thread labels its rows each
// time it changes.
let formats: Record<"clock" | "weekday" | "day", Intl.DateTimeFormat> | undefined;

export function timeLabel(time: number, now = Date.now()): string {
  formats ??= {
    clock: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }),
    weekday: new Intl.DateTimeFormat(undefined, { weekday: "short" }),
    day: new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }),
  };
  const at = new Date(time);
  const clock = formats.clock.format(at);
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return clock;
  if (now - time < 6 * DAY_MS) return `${formats.weekday.format(at)} ${clock}`;
  return `${formats.day.format(at)}, ${clock}`;
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
