import { ULID_PATTERN } from "@localdot/protocol";
import type { ApiClient } from "../lib/api.ts";

export interface SideAnswer {
  readonly answer: string;
  readonly provider: string;
  readonly model: string;
}

// The daemon's reasons, as the user reads them.
const PROBLEMS: Record<string, string> = {
  "no-fast-model":
    "Side questions need a Fast model on Claude Code or an API key. Choose one in Settings → Models.",
  "fast-model-not-running":
    "Your Fast model answers through a running task. Ask while dot is working, or choose a Fast model on Claude Code.",
  busy: "Wait for the answer to your last side question.",
};
const NO_ANSWER = "Your Fast model didn't answer. Try again.";

export class SideQuestionFailure extends Error {
  constructor(
    message: string,
    // The fix is choosing a Fast model.
    readonly setup = false,
  ) {
    super(message);
    this.name = "SideQuestionFailure";
  }
}

// Asks the task's Fast model one question about the task. Neither the question nor the answer ever
// reaches dot.
export async function askSideQuestion(
  api: ApiClient,
  sessionId: string,
  question: string,
  signal: AbortSignal,
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
        signal: AbortSignal.any([signal, AbortSignal.timeout(100_000)]),
        redirect: "error",
        cache: "no-store",
      },
    );
  } catch {
    signal.throwIfAborted();
    throw new SideQuestionFailure("Couldn't reach your computer. Try again.");
  }
  if (response.status === 401) api.rejectUnauthorized?.();
  const text = await response.text().catch(() => "");
  if (response.ok) {
    let reply: Partial<SideAnswer> = {};
    try {
      reply = JSON.parse(text) as Partial<SideAnswer>;
    } catch {}
    if (typeof reply.answer === "string" && reply.answer.trim())
      return {
        answer: reply.answer,
        provider: String(reply.provider ?? ""),
        model: String(reply.model ?? ""),
      };
    throw new SideQuestionFailure(NO_ANSWER);
  }
  if (response.status === 400)
    throw new SideQuestionFailure(
      "Write a question of up to 2,000 characters, with no keys in it.",
    );
  if (response.status === 404) throw new SideQuestionFailure("This task can't be asked about.");
  throw new SideQuestionFailure(
    PROBLEMS[text] ?? NO_ANSWER,
    text === "no-fast-model" || text === "fast-model-not-running",
  );
}
