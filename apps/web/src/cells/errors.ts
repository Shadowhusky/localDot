import type { ReplacementRecord } from "@localdot/protocol";
import { t, tr } from "../i18n/index.ts";
import { ApiError } from "../lib/api.ts";

export const DOCKER_DOWN = t`Docker isn't answering. Check that Docker Desktop is running, then try again.`;
export const GONE = t`This computer no longer exists.`;
export const RECOVERY_RUNTIME_UNAVAILABLE = t`Docker isn't responding. Start or restart Docker on the host computer, then try again. Your files are kept.`;

export function replacementNotice(
  record: Pick<ReplacementRecord, "phase" | "reason"> | null | undefined,
  error?: string | null,
): string | undefined {
  if (error) return error;
  if (record?.phase === "blocked")
    return record.reason === "old_retirement"
      ? t`The old computer couldn't be saved and shut down safely. Your files are kept. Check Docker, then try again.`
      : t`The fresh computer couldn't be checked. Your saved computer data is kept. Try recovery again.`;
  if (record?.phase === "ready")
    return t`Step 3 of 3 · The fresh computer is ready. Opening it. Your files are kept.`;
  if (record?.phase === "allocating" || record?.phase === "retired")
    return t`Step 2 of 3 · Starting a fresh computer. Your files are kept.`;
  return record ? t`Step 1 of 3 · Saving the old computer. Your files are kept.` : undefined;
}

const RESUME_ANSWERS: Record<string, string> = {
  "the computer is not paused": tr("Your computer isn't paused."),
  "the computer is restarting: resume it once it is ready": tr(
    "Your computer is restarting. Resume it once it's ready.",
  ),
  "the computer is changing state; try again": tr("Your computer is busy. Try again in a moment."),
  "key protection is off: turn it back on, then resume the computer": tr(
    "Key protection is off. Run localdot doctor in Terminal, then resume.",
  ),
};

// The daemon's advice when Docker's memory may not hold one more computer (dots/capacity.ts).
export const MEMORY_ADVICE =
  /\w+ running computers need about \d+ GB for Docker; it has \d+ GB\. [\w →,]+\./;

// What the computers of every dot on this computer share: Docker's memory and network addresses.
// These answers are already plain words, so they are shown as given.
const SHARED_DOCKER = [
  new RegExp(`^${MEMORY_ADVICE.source}$`),
  /^Docker has no network addresses left for another computer\. /,
  /^The computer copied from another dot couldn't be set up\. /,
];

// A refused request in plain words, by status: the daemon's and Docker's own text (paths, errno
// codes, cell ids) stays out of the caption.
export function describeRequestError(err: unknown, action?: "resume"): string {
  if (!(err instanceof ApiError))
    return t`localDot isn't answering. Check that it's running on your computer.`;
  if (action === "resume" && [409, 502, 503].includes(err.status)) {
    // Only the route's fixed answers are recognised, each said in plain words; never echo internals.
    return RESUME_ANSWERS[err.message] ?? t`Your computer couldn't resume. Try again.`;
  }
  switch (err.status) {
    case 502:
      return DOCKER_DOWN;
    case 404:
      return GONE;
    case 409:
      if (SHARED_DOCKER.some((answer) => answer.test(err.message))) return err.message;
      if (
        err.message.startsWith("cell records ") ||
        err.message === "unreadable cell records may retain keyd ports"
      )
        return t`A saved computer record couldn’t be read. Your data is kept. Run localdot doctor in Ubuntu or Terminal to check recovery.`;
      if (
        err.message === "Computer runtime update recovery is incomplete." ||
        err.message === "installed service recovery could not be confirmed"
      )
        return t`localDot hasn’t finished recovering after the update. Your data is kept. Run localdot up in Ubuntu or Terminal, then try again.`;
      if (err.message === "computer identity is unavailable")
        return t`This computer is already being created or recovered. Wait a moment, then try again.`;
      return t`The computer couldn’t start this action in its current state. Try again; if it persists, run localdot doctor in Ubuntu or Terminal.`;
    default:
      return err.status >= 500
        ? t`localDot couldn't do that. Try again.`
        : t`localDot couldn't do that.`;
  }
}
