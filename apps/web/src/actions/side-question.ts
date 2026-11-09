import { ULID_PATTERN } from "@localdot/protocol";
import type { ApiClient } from "../lib/api.ts";

export interface SideAnswer {
  readonly answer: string;
  readonly provider: string;
  readonly model: string;
  // Whether it found out, as the model reported it.
  readonly status?: "found" | "partial" | "not_found";
  // Where the answer came from.
  readonly sources?: readonly string[];
  // The addresses its answer may link to; any other shows as text.
  readonly links?: readonly string[];
  // A model that failed, and why.
  readonly failed?: { readonly model: string; readonly reason: string };
  // The model that looked first and couldn't find it.
  readonly handedOver?: { readonly provider: string; readonly model: string };
  // Why it ended before finding out.
  readonly ended?: "time" | "cost" | "no-main";
  readonly spend?: {
    readonly usd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly plan: boolean;
    readonly taskUSD: number;
  };
}
// What the side agent is doing, as it does it.
export type SideStep =
  | { readonly progress: string }
  | {
      readonly handover: { readonly provider: string; readonly model: string };
      readonly partial?: string;
    };

// The daemon's reasons, as the user reads them.
const PROBLEMS: Record<string, string> = {
  "no-model": "Choose a model for this task first.",
  "no-spare-model":
    "The ChatGPT plan answers one request at a time, and this task needs it, so it can't take a side question. A task's record stays with the models you chose for it.",
  "no-tool-model":
    "Side questions need a model that can use tools, and this task's models can't use tools. A task's record stays with the models you chose for it.",
  busy: "Wait for the answer to your last side question.",
};
const NO_ANSWER = "No model could answer. Try again.";
// Longer than the daemon's own limit for a side question, which ends with what it found.
const ANSWER_MS = 140_000;

export class SideQuestionFailure extends Error {
  constructor(
    message: string,
    // The fix is choosing a model.
    readonly setup = false,
  ) {
    super(message);
    this.name = "SideQuestionFailure";
  }
}

const refusal = (problem: string, reason: string | undefined) => {
  const said = PROBLEMS[problem] ?? NO_ANSWER;
  return new SideQuestionFailure(
    reason ? `${said} (${reason})` : said,
    problem === "no-model" || problem === "no-spare-model" || problem === "no-tool-model",
  );
};

async function* linesOf(response: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let pending = "";
  const parsed = (line: string) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const read = line.trim() ? parsed(line) : undefined;
        if (read) yield read;
      }
    }
    const last = pending.trim() ? parsed(pending) : undefined;
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Asks the side agent one question about the task, each step coming as it takes it. Neither the
// question nor the answer ever reaches dot.
export async function askSideQuestion(
  api: ApiClient,
  sessionId: string,
  question: string,
  signal: AbortSignal,
  onStep?: (step: SideStep) => void,
): Promise<SideAnswer> {
  if (!ULID_PATTERN.test(sessionId)) throw new SideQuestionFailure("Start a task first.");
  let response: Response;
  try {
    response = await api.fetch(
      `${api.socketUrl("").replace(/^ws/, "http")}/api/agent/sessions/${sessionId}/side-question`,
      {
        method: "POST",
        headers: { authorization: api.authorization(), "content-type": "application/json" },
        body: JSON.stringify({ question }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(ANSWER_MS)]),
        redirect: "error",
        cache: "no-store",
      },
    );
  } catch {
    signal.throwIfAborted();
    throw new SideQuestionFailure("Couldn't reach your computer. Try again.");
  }
  if (response.status === 401) api.rejectUnauthorized?.();
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 400)
      throw new SideQuestionFailure(
        "Write a question of up to 2,000 characters, with no keys in it.",
      );
    if (response.status === 404) throw new SideQuestionFailure("This task can't be asked about.");
    const [problem = "", reason] = text.split("\n");
    throw refusal(problem, reason);
  }
  try {
    for await (const line of linesOf(response)) {
      if (typeof line.answer === "string" && line.answer.trim())
        return {
          ...(line as unknown as SideAnswer),
          provider: String(line.provider ?? ""),
          model: String(line.model ?? ""),
        };
      if (typeof line.problem === "string")
        throw refusal(line.problem, typeof line.reason === "string" ? line.reason : undefined);
      if (typeof line.progress === "string") onStep?.({ progress: line.progress });
      else if (line.handover) onStep?.(line as unknown as SideStep);
    }
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SideQuestionFailure) throw error;
    throw new SideQuestionFailure("Couldn't reach your computer. Try again.");
  }
  throw new SideQuestionFailure(NO_ANSWER);
}
