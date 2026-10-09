import { type ComputerAction, computerWorkMs, type ShellInput } from "@localdot/protocol";
import type { AgentSession } from "../session.ts";

const WORK_MS = 120_000;
const TICK_MS = 1000;

type WaitingSession = Pick<AgentSession, "pendingApproval" | "controlHeld" | "pendingAsk">;

// Bounds one tool call's own work. Time the task spends waiting on the user (an approval card,
// a hand-off or a question) does not count, so an unanswered card never cancels the step.
export class WorkClock {
  readonly #abort = new AbortController();
  readonly #timer: ReturnType<typeof setInterval>;
  #spent = 0;
  #last = performance.now();

  constructor(allowanceMs: number, waiting: () => boolean) {
    this.#timer = setInterval(() => {
      const now = performance.now();
      if (!waiting()) this.#spent += now - this.#last;
      this.#last = now;
      if (this.#spent < allowanceMs) return;
      this.stop();
      this.#abort.abort(new Error("the tool call ran out of time"));
    }, TICK_MS);
    this.#timer.unref?.();
  }
  get signal(): AbortSignal {
    return this.#abort.signal;
  }
  get expired(): boolean {
    return this.#abort.signal.aborted;
  }
  stop(): void {
    clearInterval(this.#timer);
  }
}

// The model's own questions and hand-off requests wait on the user by design, with their own limits.
export function startWorkClock(
  session: WaitingSession,
  tool: string,
  input: unknown,
): WorkClock | undefined {
  if (tool === "ask_user" || tool === "request_takeover") return undefined;
  const allowance =
    tool === "shell"
      ? (((input as ShellInput).timeout_sec ?? 120) + 10) * 1000
      : tool === "computer"
        ? computerWorkMs(input as ComputerAction)
        : WORK_MS;
  return new WorkClock(
    allowance,
    () =>
      session.pendingApproval !== undefined ||
      session.controlHeld ||
      session.pendingAsk !== undefined,
  );
}
