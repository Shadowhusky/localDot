import type { ClaudeCodeStatus } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { claudeCodeSteps } from "./claude-code-steps.ts";

const status = (fields: Partial<ClaudeCodeStatus>): ClaudeCodeStatus => ({
  state: "signed_out",
  models: [],
  ...fields,
});
const states = (value: ClaudeCodeStatus | null, checking = false) =>
  claudeCodeSteps(value, checking).map((step) => [step.state, step.detail]);

describe("Claude Code setup steps", () => {
  it("installs, then signs in, both in Claude Code itself", () => {
    expect(states(status({ state: "not_installed" }))).toEqual([
      ["todo", "Not on this Mac yet"],
      ["todo", "With your Claude plan, in Terminal"],
    ]);
    expect(states(status({ state: "signed_out", version: "2.1.290" }))).toEqual([
      ["done", "Version 2.1.290"],
      ["todo", "Not signed in"],
    ]);
    expect(
      states(
        status({
          state: "signed_in",
          version: "2.1.290",
          plan: "max",
          models: [{ id: "sonnet", name: "Sonnet" }],
        }),
      ),
    ).toEqual([
      ["done", "Version 2.1.290"],
      ["done", "Signed in · Max plan"],
    ]);
  });
  it("shows the step it is looking at while it checks, and a version too old to use", () => {
    expect(states(null)[0]).toEqual(["doing", "Checking…"]);
    expect(states(status({ state: "signed_out", version: "2.1.290" }), true)[1]).toEqual([
      "doing",
      "Checking…",
    ]);
    expect(states(status({ state: "outdated", version: "2.1.100" }))[0]).toEqual([
      "failed",
      "Version 2.1.100 is too old to use here",
    ]);
  });
});
