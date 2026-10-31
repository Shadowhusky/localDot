import { RETRY_NEXT } from "./native-tools.ts";
import type { Redactor } from "./redact.ts";
import { NativeCleanupPending } from "./safety/native-tasks.ts";

// How far a native harness's start got: the step it was on when it failed.
export type StartupStep = "screens" | "install" | "history" | "screen" | "launch" | "connection";

// Task input localDot will not hand to a native harness.
export class InputRefused extends Error {
  constructor(readonly why: "secret" | "size") {
    super(
      why === "secret"
        ? "Protected task input cannot be persisted."
        : "The task input is too large.",
    );
    this.name = "InputRefused";
  }
}

export interface StartupFailure {
  // What the event's reason, detail and next say: fixed words, never the error's own.
  readonly message: string;
  readonly detail: string;
  readonly next?: string;
}

const AGAIN = "Send your message again.";
const STEPS: Record<StartupStep, { detail: string; next: string }> = {
  screens: { detail: "Its screen couldn't be set up.", next: AGAIN },
  install: {
    detail: "localDot couldn't check the installation.",
    next: "Check it under Settings, then send your message again.",
  },
  history: {
    detail: "The task's history couldn't be read or saved.",
    next: "Send your message again in a new conversation.",
  },
  screen: {
    detail: "The computer's screen couldn't be read.",
    next: "Wait until the computer is ready, then send your message again.",
  },
  launch: { detail: "localDot couldn't launch it.", next: RETRY_NEXT },
  connection: { detail: "It didn't answer as expected.", next: RETRY_NEXT },
};

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// Node and parsers quote the data they choke on, which may be the user's words.
const QUOTED = /"[^"]*"|'[^']*'|`[^`]*`/g;

// An error as the daemon log may keep it: its name and its words, without anything quoted, the
// task's text or a known secret, on one clipped line.
export function loggedCause(cause: unknown, redact: Redactor, task: string): string {
  if (!(cause instanceof Error)) return "a thrown non-error";
  let said = cause.message.replace(QUOTED, "…");
  if (task.trim().length >= 4) said = said.split(task).join("[task]");
  said = redact(said)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const line = `${NAME.test(cause.name) ? cause.name : "Error"}: ${said}`;
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

// A native harness that could not start: the daemon log gets the step and the real cause, the
// user a reason they can act on.
export function startupFailure(input: {
  harness: "Claude Code" | "ChatGPT";
  message: string;
  step: StartupStep;
  cause: unknown;
  sessionId: string;
  redact: Redactor;
  task: string;
}): StartupFailure {
  const { harness, message, step, cause } = input;
  console.error(
    `${harness} could not start (${step}): ${loggedCause(cause, input.redact, input.task)} (task ${input.sessionId})`,
  );
  if (cause instanceof InputRefused)
    return cause.why === "secret"
      ? {
          message,
          detail: "The task includes a key or token, which localDot doesn't pass on.",
          next: "Send the task again without it.",
        }
      : {
          message,
          detail: "The task is too long to start.",
          next: "Shorten your message, then send it again.",
        };
  if (cause instanceof NativeCleanupPending)
    return {
      message,
      detail: `An earlier ${harness} task on this computer hasn't been confirmed stopped.`,
      next: "Run localdot doctor to check the computer, then send your message again.",
    };
  return { message, ...STEPS[step] };
}
