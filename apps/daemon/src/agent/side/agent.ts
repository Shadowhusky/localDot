import { ModelAnswerError } from "../safety/judge-model.ts";
import { sideAnswerText } from "../side-question.ts";
import { untrusted } from "../untrusted.ts";
import {
  type SideFinish,
  type SideReaders,
  type SideSource,
  type SideStatus,
  SideToolbox,
} from "./tools.ts";

export const SIDE_LIMITS = {
  // The whole question, both models together.
  timeMs: 120_000,
  // One model, so the one after it still has time.
  modelMs: 75_000,
  // Reads each model may make.
  calls: 8,
  // Shared by both models. A plan bills no money, so its tokens count instead.
  usd: 0.25,
  planTokens: 300_000,
};
export type SideLimits = typeof SIDE_LIMITS;
// Below this much time, or above this share of the money, a model gets no more reads: what's left
// is for writing up what it found.
const WRAP_UP_MS = 15_000;
const WRAP_UP_SHARE = 0.8;
// Handing over takes at least this much time, and a share of the money small enough to leave some.
const HAND_OVER_MS = 25_000;
const HAND_OVER_SHARE = 0.6;

export interface SideUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd?: number;
}
// One model's go at the question. It reads through `tools` and calls finish; an answer in anything
// but finish is only a note.
export interface SideGo {
  readonly system: string;
  readonly prompt: string;
  readonly tools: Pick<SideToolbox, "offered" | "call" | "finished">;
  readonly signal: AbortSignal;
  readonly leftUSD: number;
  // Model calls it may make: its reads, then room to write up.
  readonly turns: number;
  used(usage: SideUsage): void;
  note(text: string): void;
}
export interface SideModel {
  readonly provider: string;
  readonly model: string;
  readonly role: "fast" | "main" | "other";
  readonly tools: boolean;
  readonly images: boolean;
  // On a plan: no money, but tokens against its limits.
  readonly plan?: boolean;
  run(go: SideGo): Promise<void>;
}
export type SideEvent =
  | { readonly progress: string }
  | {
      readonly handover: { readonly provider: string; readonly model: string };
      readonly partial?: string;
    };
export type SideEnd = "time" | "cost" | "no-main";
export interface SideSpendRow {
  readonly at: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
}
export interface SideSpendLedger {
  record(rows: readonly SideSpendRow[]): void;
  taskUSD(): number;
}
export interface SideReply {
  readonly answer: string;
  readonly provider: string;
  readonly model: string;
  readonly status: SideStatus;
  readonly sources: readonly SideSource[];
  // A model that failed or refused, and why.
  readonly failed?: { readonly model: string; readonly reason: string };
  // The model that looked first and couldn't find it.
  readonly handedOver?: { readonly provider: string; readonly model: string };
  // Why it ended before finding out.
  readonly ended?: SideEnd;
  readonly spend: {
    readonly usd: number;
    readonly limitUSD: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly plan: boolean;
    // Every side question on this task so far, this one included.
    readonly taskUSD: number;
  };
}
export class SideNoAnswer extends Error {
  constructor(readonly reason?: string) {
    super("no-answer");
    this.name = "SideNoAnswer";
  }
}
export interface SideRun {
  readonly models: readonly SideModel[];
  readonly readers: SideReaders;
  readonly question: string;
  readonly system: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly limits?: Partial<SideLimits>;
  readonly spend?: SideSpendLedger;
  onEvent?(event: SideEvent): void;
  onFailed?(model: SideModel, reason: string): void;
  onAnswered?(model: SideModel): void;
  now?(): number;
}

const reasonOf = (error: unknown) =>
  error instanceof ModelAnswerError
    ? error.reason === "budget_exceeded day"
      ? "today's spending limit is reached"
      : error.message
    : "it could not be reached";
// keyd stopped it at what was left of this question's own limit.
const atOwnLimit = (error: unknown) =>
  error instanceof ModelAnswerError && error.reason === "budget_exceeded task";

class SideMeter {
  usd = 0;
  input = 0;
  output = 0;
  readonly rows = new Map<SideModel, { input: number; output: number; usd: number }>();
  readonly #started: number;
  constructor(
    private readonly limits: SideLimits,
    private readonly now: () => number,
  ) {
    this.#started = now();
  }
  add(model: SideModel, usage: SideUsage): void {
    const usd = usage.usd ?? 0;
    this.usd += usd;
    this.input += usage.inputTokens;
    this.output += usage.outputTokens;
    const row = this.rows.get(model) ?? { input: 0, output: 0, usd: 0 };
    this.rows.set(model, {
      input: row.input + usage.inputTokens,
      output: row.output + usage.outputTokens,
      usd: row.usd + usd,
    });
  }
  get leftMs(): number {
    return this.limits.timeMs - (this.now() - this.#started);
  }
  get leftUSD(): number {
    return Math.max(0, this.limits.usd - this.usd);
  }
  #tokensShare(): number {
    return (this.input + this.output) / this.limits.planTokens;
  }
  wrappingUp(): boolean {
    return (
      this.leftMs < WRAP_UP_MS ||
      this.usd >= this.limits.usd * WRAP_UP_SHARE ||
      this.#tokensShare() >= WRAP_UP_SHARE
    );
  }
  // Why another model can't start now.
  noRoom(): SideEnd | undefined {
    if (this.leftMs < HAND_OVER_MS) return "time";
    if (this.usd >= this.limits.usd * HAND_OVER_SHARE || this.#tokensShare() >= HAND_OVER_SHARE)
      return "cost";
    return undefined;
  }
}

// The side agent: the fast model, then the main one. A model that fails, refuses or lacks what's
// needed leaves the question to the next. One that finishes saying it couldn't find the answer hands
// over to the main model what it found and what it checked, and both spend against one limit.
export async function runSideAgent(run: SideRun): Promise<SideReply> {
  const limits = { ...SIDE_LIMITS, ...run.limits };
  const now = run.now ?? Date.now;
  const meter = new SideMeter(limits, now);
  const deadline = AbortSignal.timeout(limits.timeMs);
  const toolbox = new SideToolbox(
    run.readers,
    run.question,
    () => meter.wrappingUp(),
    (line) => run.onEvent?.({ progress: line }),
  );
  let best: { finish: SideFinish; by: SideModel } | undefined;
  let failed: { model: string; reason: string } | undefined;
  let handedOver: SideModel | undefined;
  let ended: SideEnd | undefined;
  let lastFailure: string | undefined;
  const fail = (model: SideModel, reason: string) => {
    failed ??= { model: model.model, reason };
    lastFailure = reason;
    run.onFailed?.(model, reason);
  };
  // What was spent is spent, however the question ends.
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    const at = new Date(now()).toISOString();
    try {
      run.spend?.record(
        [...meter.rows].map(([model, row]) => ({
          at,
          provider: model.provider,
          model: model.model,
          inputTokens: row.input,
          outputTokens: row.output,
          usd: row.usd,
        })),
      );
    } catch {
      console.error("a side question's spending could not be saved");
    }
  };
  const asked = `Side question: ${run.question}`;
  const before = run.prompt.endsWith(asked)
    ? run.prompt.slice(0, -asked.length).trimEnd()
    : run.prompt;
  try {
    for (const model of run.models) {
      // A model that couldn't find it goes to the main model, and only that one.
      if (best && (best.finish.status === "found" || model.role !== "main")) continue;
      if (!model.tools) {
        fail(model, "it can't use tools");
        continue;
      }
      ended = meter.noRoom();
      if (ended) break;
      if (best) {
        handedOver = best.by;
        run.onEvent?.({
          handover: { provider: model.provider, model: model.model },
          partial: best.finish.answer,
        });
      }
      toolbox.beginModel({ images: model.images, calls: limits.calls });
      const slice = AbortSignal.any([run.signal, deadline, AbortSignal.timeout(limits.modelMs)]);
      let note = "";
      const prompt = best
        ? [
            before,
            untrusted(
              "what a faster model found first",
              `${best.finish.answer}\n\nIt already checked:\n${toolbox.trail.join("\n") || "(nothing but the record)"}`,
            ),
            "A faster model looked first and couldn't settle this. Use what it found, don't repeat what it checked, and look where it didn't.",
            asked,
          ].join("\n\n")
        : run.prompt;
      let thrown: unknown;
      try {
        await model.run({
          system: run.system,
          prompt,
          tools: toolbox,
          signal: slice,
          leftUSD: meter.leftUSD,
          turns: limits.calls + 2,
          used: (usage) => meter.add(model, usage),
          note: (text) => {
            if (text.trim()) note = text;
          },
        });
      } catch (error) {
        run.signal.throwIfAborted();
        thrown = error;
      }
      const finish = toolbox.finished;
      if (finish) {
        run.onAnswered?.(model);
        best = { finish, by: model };
        if (finish.status === "found") break;
        continue;
      }
      if (deadline.aborted) ended = "time";
      else if (thrown && atOwnLimit(thrown)) ended = "cost";
      else if (thrown) fail(model, slice.aborted ? "it took too long" : reasonOf(thrown));
      else fail(model, "it gave no result");
      // What it said before it stopped is still something found, though not a result.
      if (note.trim() && !best)
        best = {
          finish: { status: "partial", answer: note.trim(), sources: toolbox.consulted },
          by: model,
        };
      if (ended) break;
    }
    if (!best)
      throw new SideNoAnswer(
        ended === "cost"
          ? "it reached its cost limit"
          : ended === "time"
            ? "it ran out of time"
            : lastFailure,
      );
    if (
      best.finish.status !== "found" &&
      !ended &&
      best.by.role !== "main" &&
      !run.models.some((model) => model.role === "main" && model !== best?.by)
    )
      ended = "no-main";
    settle();
    return {
      answer: sideAnswerText(best.finish.answer),
      provider: best.by.provider,
      model: best.by.model,
      status: best.finish.status,
      sources: best.finish.sources,
      ...(failed ? { failed } : {}),
      ...(handedOver && handedOver !== best.by
        ? { handedOver: { provider: handedOver.provider, model: handedOver.model } }
        : {}),
      ...(ended ? { ended } : {}),
      spend: {
        usd: meter.usd,
        limitUSD: limits.usd,
        inputTokens: meter.input,
        outputTokens: meter.output,
        plan: [...meter.rows.keys()].some((model) => model.plan),
        taskUSD: run.spend?.taskUSD() ?? meter.usd,
      },
    };
  } finally {
    settle();
  }
}
