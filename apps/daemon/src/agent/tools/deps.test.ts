import { describe, expect, it } from "vitest";
import { redactor } from "../redact.ts";
import { intentOf, type ToolCallContext } from "./deps.ts";

describe("a call's line for the user", () => {
  const ctx = { redact: redactor(["hunter2-is-the-password"]) } as ToolCallContext;

  it("masks what the session keeps secret before cutting the line to its limit", () => {
    const line = intentOf(ctx, {
      intent: `${"Typing ".repeat(16)}hunter2-is-the-password into the box`,
    }).intent;
    expect(line).not.toContain("hunter2");
    expect([...(line ?? "")].length).toBeLessThanOrEqual(120);
    expect(intentOf(ctx, { intent: "Typing hunter2-is-the-password" })).toEqual({
      intent: "Typing [redacted]",
    });
  });

  it("is left out when the model gave none", () => {
    expect(intentOf(ctx, {})).toEqual({});
    expect(intentOf(ctx, { intent: " \n " })).toEqual({});
  });
});
