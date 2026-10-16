import type { ReplacementRecord } from "@localdot/protocol";
import { ApiError } from "../lib/api.ts";

export const DOCKER_DOWN = "Docker isn't answering. Check that Docker Desktop is running";
export const GONE = "This computer no longer exists.";
export const RECOVERY_RUNTIME_UNAVAILABLE =
  "Docker isn't responding. Start or restart Docker on the host computer, then try again. Your files are kept.";

export function replacementNotice(
  record: Pick<ReplacementRecord, "phase" | "reason"> | null | undefined,
  error?: string | null,
): string | undefined {
  if (error) return error;
  if (record?.phase === "blocked")
    return record.reason === "old_retirement"
      ? "The old computer couldn't be saved and shut down safely. Your files are kept. Check Docker, then try again."
      : "The fresh computer couldn't be checked. Your saved computer data is kept. Try recovery again.";
  if (record?.phase === "ready") return "The fresh computer is ready. Opening it…";
  return record ? "Saving the old computer and starting a fresh one." : undefined;
}

const RESUME_ANSWERS: Record<string, string> = {
  "the computer is not paused": "Your computer isn't paused.",
  "the computer is restarting: resume it once it is ready":
    "Your computer is restarting. Resume it once it's ready.",
  "the computer is changing state; try again": "Your computer is busy. Try again in a moment.",
  "key protection is off: turn it back on, then resume the computer":
    "Key protection is off. Run localdot doctor in Terminal, then resume.",
};

// A refused request in plain words, by status: the daemon's and Docker's own text (paths, errno
// codes, cell ids) stays out of the caption.
export function describeRequestError(err: unknown, action?: "resume"): string {
  if (!(err instanceof ApiError))
    return "localDot isn't answering. Check that it's running on your computer.";
  if (action === "resume" && [409, 502, 503].includes(err.status)) {
    // Only the route's fixed answers are recognised, each said in plain words; never echo internals.
    return RESUME_ANSWERS[err.message] ?? "Your computer couldn't resume. Try again.";
  }
  switch (err.status) {
    case 502:
      return `${DOCKER_DOWN}, then try again.`;
    case 404:
      return GONE;
    case 409:
      if (
        err.message.startsWith("cell records ") ||
        err.message === "unreadable cell records may retain keyd ports"
      )
        return "A saved computer record couldn’t be read. Your data is kept. Run localdot doctor in Ubuntu or Terminal to check recovery.";
      if (
        err.message === "Computer runtime update recovery is incomplete." ||
        err.message === "installed service recovery could not be confirmed"
      )
        return "localDot hasn’t finished recovering after the update. Your data is kept. Run localdot up in Ubuntu or Terminal, then try again.";
      if (err.message === "computer identity is unavailable")
        return "This computer is already being created or recovered. Wait a moment, then try again.";
      return "The computer couldn’t start this action in its current state. Try again; if it persists, run localdot doctor in Ubuntu or Terminal.";
    default:
      return err.status >= 500
        ? "localDot couldn't do that. Try again."
        : "localDot couldn't do that.";
  }
}
