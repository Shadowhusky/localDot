import { ApiError } from "../lib/api.ts";

export const DOCKER_DOWN = "Docker isn't answering. Check that Docker Desktop is running";
export const GONE = "This computer no longer exists.";

const RESUME_ANSWERS: Record<string, string> = {
  "the computer is not paused": "Your computer isn't paused.",
  "the computer is restarting: resume it once it is ready":
    "Your computer is restarting. Resume it once it's ready.",
  "the computer is changing state; try again": "Your computer is busy. Try again in a moment.",
  "the key layer is offline: start keyd, then resume the computer":
    "Key protection is off. Run localdot doctor in Terminal, then resume.",
};

// A refused request in plain words, by status: the daemon's and Docker's own text (paths, errno
// codes, cell ids) stays out of the caption.
export function describeRequestError(err: unknown, action?: "resume"): string {
  if (!(err instanceof ApiError))
    return "localDot isn't answering. Check that it's running on your Mac.";
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
      return "Some computer records can't be read. Fix or remove them in localDot's cells folder, then try again.";
    default:
      return err.status >= 500
        ? "localDot couldn't do that. Try again."
        : "localDot couldn't do that.";
  }
}
