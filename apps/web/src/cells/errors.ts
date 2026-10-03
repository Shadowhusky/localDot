import { ApiError } from "../lib/api.ts";

export const DOCKER_DOWN = "Docker isn't answering. Check that Docker Desktop is running";
export const GONE = "This computer no longer exists.";

// A refused request in plain words, by status: the daemon's and Docker's own text (paths, errno
// codes, cell ids) stays out of the caption.
export function describeRequestError(err: unknown, action?: "resume"): string {
  if (!(err instanceof ApiError))
    return "localDot's daemon isn't answering. Check that it's running.";
  if (action === "resume" && [409, 502, 503].includes(err.status)) {
    // Only the route's fixed, user-facing answers may pass through; never echo internals.
    const known: Record<number, readonly string[]> = {
      409: [
        "the computer is not paused",
        "the computer is restarting: resume it once it is ready",
        "the computer is changing state; try again",
      ],
      503: ["the key layer is offline: start keyd, then resume the computer"],
    };
    return known[err.status]?.includes(err.message)
      ? err.message
      : "The computer could not resume. Try again.";
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
        ? "The daemon couldn't do that. Try again."
        : "The daemon refused that request.";
  }
}
