import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api.ts";
import { describeRequestError, RECOVERY_RUNTIME_UNAVAILABLE, replacementNotice } from "./errors.ts";

// Bodies the daemon really sends: apps/daemon/src/cells/api.ts and DockerError's message, captured
// from a daemon run against a missing Docker socket.
const DOCKER_DOWN = "docker unreachable on /networks/create: ENOENT; is Docker Desktop running?";
const SKIPPED =
  "cell records that can't be read (01JXYZ0000000000000000ABCD) may still hold their keyd ports: fix or remove them in the cells folder before creating another computer";

describe("describeRequestError", () => {
  it("reports safe Resume answers without echoing arbitrary server errors or calling every 502 a Docker outage", () => {
    const offline = "key protection is off: turn it back on, then resume the computer";
    expect(describeRequestError(new ApiError(503, offline), "resume")).toBe(
      "Key protection is off. Run localdot doctor in Terminal, then resume.",
    );
    for (const status of [409, 502, 503]) {
      const message = describeRequestError(new ApiError(status, "private-internal-path"), "resume");
      expect(message).not.toContain("private-internal-path");
      expect(message).not.toContain("Docker");
      expect(message).toContain("resume");
    }
  });

  it("says plainly what several dots' computers lack on one Docker", () => {
    for (const answer of [
      "Two running computers need about 10 GB for Docker; it has 8 GB. Raise it in Docker Desktop → Settings → Resources.",
      "Docker has no network addresses left for another computer. Remove a computer you no longer use, on any dot on this computer, then try again.",
      "The computer copied from another dot couldn't be set up. Start again for a new computer.",
    ])
      expect(describeRequestError(new ApiError(409, answer))).toBe(answer);
    expect(
      describeRequestError(new ApiError(409, "Two running computers need /etc/x")),
    ).not.toContain("/etc");
  });

  it("maps each status to a plain sentence and keeps the daemon's text out", () => {
    expect(describeRequestError(new ApiError(502, DOCKER_DOWN))).toBe(
      "Docker isn't answering. Check that Docker Desktop is running, then try again.",
    );
    expect(describeRequestError(new ApiError(404, "unknown cell"))).toBe(
      "This computer no longer exists.",
    );
    expect(describeRequestError(new ApiError(409, SKIPPED))).toBe(
      "A saved computer record couldn’t be read. Your data is kept. Run localdot doctor in Ubuntu or Terminal to check recovery.",
    );
    expect(describeRequestError(new ApiError(500, "internal error"))).toBe(
      "localDot couldn't do that. Try again.",
    );
    expect(describeRequestError(new ApiError(400, "invalid cell id"))).toBe(
      "localDot couldn't do that.",
    );
  });

  it("says the daemon can't be reached when no answer came back", () => {
    expect(describeRequestError(new TypeError("Failed to fetch"))).toBe(
      "localDot isn't answering. Check that it's running on your computer.",
    );
  });
});

it("does not diagnose generic startup conflicts as corrupt computer records", () => {
  expect(
    describeRequestError(new ApiError(409, "Computer runtime update recovery is incomplete.")),
  ).toContain("recovering after the update");
  expect(describeRequestError(new ApiError(409, "computer identity is unavailable"))).toContain(
    "already being created",
  );
  const unknown = describeRequestError(new ApiError(409, "private /home/name/cells/record"));
  expect(unknown).not.toContain("record");
  expect(unknown).not.toContain("/home");
  expect(unknown).not.toContain("remove");
});

it("explains the stage that failed instead of claiming a fresh computer was created", () => {
  const old = { phase: "blocked", reason: "old_retirement" } as const;
  const note = replacementNotice(old);
  expect(note).toContain("old computer");
  expect(note).not.toContain("fresh computer");
  expect(note).toContain("files are kept");
  expect(replacementNotice({ phase: "blocked", reason: "new_creation" })).toContain(
    "fresh computer",
  );
  expect(replacementNotice(old, RECOVERY_RUNTIME_UNAVAILABLE)).toBe(RECOVERY_RUNTIME_UNAVAILABLE);
  expect(replacementNotice(undefined, RECOVERY_RUNTIME_UNAVAILABLE)).toBe(
    RECOVERY_RUNTIME_UNAVAILABLE,
  );
  expect(replacementNotice(undefined)).toBeUndefined();
});
