import { describe, expect, it } from "vitest";
import { purposeDescription, purposeJudge } from "./PurposeCheck.tsx";

describe("the purpose check row", () => {
  const fast = { provider: "anthropic", model: "fast-model" } as const;
  it("names who checks the way the daemon chooses", () => {
    expect(purposeJudge(true, {})).toBe("jev");
    expect(purposeJudge(false, { main: fast, fast })).toBe("fast");
    expect(purposeJudge(false, { main: { provider: "chatgpt", model: "gpt-6-astra" }, fast })).toBe(
      "none",
    );
    expect(purposeJudge(false, { main: { provider: "claude-code", model: "opus" }, fast })).toBe(
      "none",
    );
    expect(purposeJudge(false, { main: fast })).toBe("none");
  });

  it("says who checks in the switch's own line, and what is missing when nobody can", () => {
    expect(purposeDescription({ on: true, judge: "jev", plan: "chatgpt" })).toMatch(
      /Checked by Jev\.$/,
    );
    expect(purposeDescription({ on: true, judge: "fast" })).toMatch(
      /Checked by your fast model\.$/,
    );
    expect(purposeDescription({ on: true, judge: "none", plan: "chatgpt" })).toMatch(
      /Needs a Jev key with the ChatGPT plan\.$/,
    );
    expect(purposeDescription({ on: true, judge: "none", plan: "claude-code" })).toMatch(
      /Needs a Jev key with Claude Code\.$/,
    );
    expect(purposeDescription({ on: true, judge: "none" })).toMatch(
      /Needs a Jev key or a fast model\.$/,
    );
    expect(purposeDescription({ on: false, judge: "jev" })).toBe(
      "Stops dot sending what it read somewhere unrelated.",
    );
  });
});
