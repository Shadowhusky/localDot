import { describe, expect, it } from "vitest";
import { ShellFailure } from "./desktopd-tools.ts";

describe("shell cleanup failure wire boundary", () => {
  const failure = { error: "cleanup uncertain", status: 500, code: "shell_cleanup_uncertain" };
  it("accepts the typed terminal failure", () => {
    expect(ShellFailure.parse(failure)).toEqual(failure);
  });
  it.each([
    { ...failure, status: 200 },
    { ...failure, code: "try_again" },
    { ...failure, done: true },
    { ...failure, groupPid: 123 },
    { error: "cleanup uncertain", status: 500 },
  ])("rejects success, missing identity and unexpected data: %j", (value) => {
    expect(ShellFailure.safeParse(value).success).toBe(false);
  });
});
