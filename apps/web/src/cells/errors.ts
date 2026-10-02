import { ApiError } from "../lib/api.ts";

export const DOCKER_DOWN = "Docker isn't answering. Check that Docker Desktop is running";
export const GONE = "This computer no longer exists.";

// A refused request in plain words, by status: the daemon's and Docker's own text (paths, errno
// codes, cell ids) stays out of the caption.
export function describeRequestError(err: unknown): string {
  if (!(err instanceof ApiError))
    return "localDot's daemon isn't answering. Check that it's running.";
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
