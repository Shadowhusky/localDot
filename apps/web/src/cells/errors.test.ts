import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api.ts";
import { describeRequestError } from "./errors.ts";

// Bodies the daemon really sends: apps/daemon/src/cells/api.ts and DockerError's message, captured
// from a daemon run against a missing Docker socket.
const DOCKER_DOWN = "docker unreachable on /networks/create: ENOENT; is Docker Desktop running?";
const SKIPPED =
  "cell records that can't be read (01JXYZ0000000000000000ABCD) may still hold their keyd ports: fix or remove them in the cells folder before creating another computer";

describe("describeRequestError", () => {
  it("reports safe Resume answers without echoing arbitrary server errors or calling every 502 a Docker outage", () => {
    const offline = "the key layer is offline: start keyd, then resume the computer";
    expect(describeRequestError(new ApiError(503, offline), "resume")).toBe(offline);
    for (const status of [409, 502, 503]) {
      const message = describeRequestError(new ApiError(status, "private-internal-path"), "resume");
      expect(message).not.toContain("private-internal-path");
      expect(message).not.toContain("Docker");
      expect(message).toContain("resume");
    }
  });

  it("maps each status to a plain sentence and keeps the daemon's text out", () => {
    expect(describeRequestError(new ApiError(502, DOCKER_DOWN))).toBe(
      "Docker isn't answering. Check that Docker Desktop is running, then try again.",
    );
    expect(describeRequestError(new ApiError(404, "unknown cell"))).toBe(
      "This computer no longer exists.",
    );
    expect(describeRequestError(new ApiError(409, SKIPPED))).toBe(
      "Some computer records can't be read. Fix or remove them in localDot's cells folder, then try again.",
    );
    expect(describeRequestError(new ApiError(500, "internal error"))).toBe(
      "The daemon couldn't do that. Try again.",
    );
    expect(describeRequestError(new ApiError(400, "invalid cell id"))).toBe(
      "The daemon refused that request.",
    );
  });

  it("says the daemon can't be reached when no answer came back", () => {
    expect(describeRequestError(new TypeError("Failed to fetch"))).toBe(
      "localDot's daemon isn't answering. Check that it's running.",
    );
  });
});
