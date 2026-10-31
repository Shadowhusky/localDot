import { describe, expect, it, vi } from "vitest";
import { InputRefused, loggedCause, startupFailure } from "./native-startup.ts";
import { redactor } from "./redact.ts";
import { NativeCleanupPending } from "./safety/native-tasks.ts";

const redact = redactor(["fake-private-diagnostic"]);
const TASK = "Draw a dog";

describe("what the daemon log keeps of a start failure", () => {
  it("keeps the error's name and words", () => {
    const error = Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
    expect(loggedCause(error, redact, TASK)).toBe("Error: EACCES: permission denied, open");
    expect(loggedCause(new NativeCleanupPending(), redact, TASK)).toBe(
      "NativeCleanupPending: previous native task cleanup is unconfirmed",
    );
  });

  it("drops quoted data, the task's words, known secrets and line breaks", () => {
    expect(
      loggedCause(
        new SyntaxError(`Unexpected token 'x', "${TASK} is" is not valid JSON`),
        redact,
        TASK,
      ),
    ).toBe("SyntaxError: Unexpected token …, … is not valid JSON");
    expect(
      loggedCause(new Error(`${TASK}: frame fake-private-diagnostic\nwas lost`), redact, TASK),
    ).toBe("Error: [task]: frame [redacted] was lost");
  });

  it("clips a long message and names a thrown non-error only by that", () => {
    const line = loggedCause(new Error("x".repeat(500)), redact, TASK);
    expect(line).toHaveLength(240);
    expect(line.endsWith("…")).toBe(true);
    expect(loggedCause("Draw a dog", redact, TASK)).toBe("a thrown non-error");
  });
});

describe("what the user is told about a start failure", () => {
  const fail = (cause: unknown, step: Parameters<typeof startupFailure>[0]["step"] = "launch") =>
    startupFailure({
      harness: "Claude Code",
      message: "Claude Code could not start.",
      step,
      cause,
      sessionId: "01M67VV22C6QD9FJ8Y343JR1B0",
      redact,
      task: TASK,
    });

  it("logs the step and cause once for the task", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fail(new Error("socket hang up"), "screen");
      expect(errors).toHaveBeenCalledExactlyOnceWith(
        "Claude Code could not start (screen): Error: socket hang up (task 01M67VV22C6QD9FJ8Y343JR1B0)",
      );
    } finally {
      errors.mockRestore();
    }
  });

  it("tells what to do for input it won't pass on, and for the step it stopped at", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(fail(new InputRefused("size"))).toEqual({
      message: "Claude Code could not start.",
      detail: "The task is too long to start.",
      next: "Shorten your message, then send it again.",
    });
    expect(fail(new Error("gone"), "screen")).toEqual({
      message: "Claude Code could not start.",
      detail: "The computer's screen couldn't be read.",
      next: "Wait until the computer is ready, then send your message again.",
    });
    vi.restoreAllMocks();
  });
});
