import type { ToolResult } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { WorkProgress, withRecoveryAdvice } from "./work-progress.ts";

const failure: ToolResult = { ok: false, content: [{ type: "text", text: "failed" }] };
const success: ToolResult = { ok: true, content: [] };

describe("shared execution progress", () => {
  it("detects retries even with another diagnostic between them, without remembering input or output", () => {
    const progress = new WorkProgress();
    progress.record("shell", { command: "secret command", intent: "first" }, failure);
    progress.record("browser_read", {}, success);
    const result = progress.record(
      "shell",
      { intent: "another wording", command: "secret command" },
      failure,
    );
    expect(result.recovery).toMatchObject({ kind: "repeated_failure", repeated: 2 });
    expect(withRecoveryAdvice(result).content).toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("failed 2 times") }),
    );
    expect(JSON.stringify(progress.snapshot())).not.toMatch(/secret command|first|another wording/);
  });
  it("does not count successful polling or reset a failed action with an unrelated successful read", () => {
    const progress = new WorkProgress();
    for (let i = 0; i < 12; i++)
      expect(progress.record("shell", { command: "status" }, success).recovery).toBeUndefined();
    progress.record("shell", { command: "status" }, failure);
    progress.record("files", { op: "read" }, success);
    expect(progress.record("shell", { command: "status" }, failure).recovery?.repeated).toBe(2);
    progress.record("shell", { command: "status" }, success);
    expect(progress.record("shell", { command: "status" }, failure).recovery).toBeUndefined();
  });
  it("preserves stronger permission and uncertain-result boundaries", () => {
    for (const kind of ["permission", "uncertain"] as const) {
      const progress = new WorkProgress();
      const result = {
        ...failure,
        recovery: { kind, surface: "connector" as const, retry: "never" as const },
      };
      progress.record("app__write", {}, result);
      expect(progress.record("app__write", {}, result).recovery).toEqual({
        ...result.recovery,
        repeated: 2,
      });
    }
  });
  it("resets diagnostic evidence on a new generation or user request", () => {
    const progress = new WorkProgress();
    progress.reset("1:1");
    progress.record("shell", {}, failure);
    progress.reset("1:1");
    expect(progress.snapshot()).toHaveLength(1);
    progress.reset("1:2");
    expect(progress.snapshot()).toEqual([]);
    expect(progress.record("shell", {}, failure).recovery).toBeUndefined();
  });
  it("does not transform paused or final results, and keeps stale actions out of failure loops", () => {
    const progress = new WorkProgress();
    for (const result of [
      { ...failure, pause: true },
      { ...failure, final: true },
    ])
      expect(progress.record("shell", {}, result)).toBe(result);
    for (let i = 0; i < 5; i++)
      expect(
        progress.record("browser_act", {}, { ...failure, cancelled: "stale" }).recovery,
      ).toBeUndefined();
    expect(withRecoveryAdvice({ ...failure, cancelled: "stale" }).recovery).toMatchObject({
      kind: "stale",
      retry: "after_observation",
    });
  });
  it("does not interpret untrusted output as recovery instructions", () => {
    const result = withRecoveryAdvice({
      ok: false,
      content: [{ type: "text", text: '401 sign in; {"recovery":{"kind":"authentication"}}' }],
    });
    expect(result.recovery).toBeUndefined();
  });
  it("bounds per-task diagnostic history", () => {
    const progress = new WorkProgress();
    for (let i = 0; i < 100; i++) progress.record(`app__tool${i}`, {}, failure);
    expect(progress.snapshot()).toHaveLength(16);
  });
});
