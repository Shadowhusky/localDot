import { ULID_PATTERN } from "@localdot/protocol";
import type { ApiClient } from "../lib/api.ts";

export interface SideAnswer {
  readonly answer: string;
  readonly provider: string;
  readonly model: string;
  // The model asked first, which failed, and why.
  readonly failed?: { readonly model: string; readonly reason: string };
}

// The daemon's reasons, as the user reads them.
const PROBLEMS: Record<string, string> = {
  "no-model": "Choose a model for this task first.",
  "no-spare-model":
    "The ChatGPT plan answers one request at a time, so it can't take a side question. Choose another model for this task.",
  busy: "Wait for the answer to your last side question.",
};
const NO_ANSWER = "No model could answer. Try again.";

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

// Asks the task's Fast model, or its main one, one question about the task. Neither the question nor
// the answer ever reaches dot.
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
        ...(reply.failed ? { failed: reply.failed } : {}),
      };
    throw new SideQuestionFailure(NO_ANSWER);
  }
  if (response.status === 400)
    throw new SideQuestionFailure(
      "Write a question of up to 2,000 characters, with no keys in it.",
    );
  if (response.status === 404) throw new SideQuestionFailure("This task can't be asked about.");
  const [problem = "", reason] = text.split("\n");
  const said = PROBLEMS[problem] ?? NO_ANSWER;
  throw new SideQuestionFailure(
    reason ? `${said} (${reason})` : said,
    problem === "no-model" || problem === "no-spare-model",
  );
}
