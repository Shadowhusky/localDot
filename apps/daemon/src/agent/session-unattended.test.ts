import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVAL_TIMEOUT_MS, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../event-log.ts";
import { AgentSession } from "./session.ts";
import { toolHarness } from "./testing/harness.ts";

const harnesses: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const h of harnesses.splice(0)) h.close();
});
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(0);
  }
  throw new Error("fixture did not reach its boundary");
}

describe("unattended sessions", () => {
  it("a step waits for the routine's window, then is refused and never dispatched", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const start = Date.parse("2026-10-12T07:30:00Z");
    vi.setSystemTime(start);
    const h = toolHarness({ autoApprove: false, approvalTtlMs: 3_600_000 });
    harnesses.push(h);
    expect(h.session.unattended).toBe(true);
    let settled = false;
    const pending = h.call("shell", { command: "ls ~/Bills" }).finally(() => {
      settled = true;
    });
    await until(() => !!h.session.pendingApproval);
    const expiresAt = h.session.pendingApproval?.expiresAt ?? 0;
    expect(expiresAt).toBeGreaterThanOrEqual(start + 3_600_000);
    expect(expiresAt).toBeLessThan(start + 3_601_000);
    await vi.advanceTimersByTimeAsync(3_599_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.body.ok).toBe(false);
    expect(h.desktop.shellCalls).toEqual([]);
    expect(h.events().find((e) => e.type === "approval.resolve")?.data).toMatchObject({
      decision: "deny",
      by: "timeout",
    });
  });

  it("a question waits for the routine's window, not the usual thirty minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const h = toolHarness({ autoApprove: false, approvalTtlMs: 3_600_000 });
    harnesses.push(h);
    let settled = false;
    const pending = h.call("ask_user", { question: "Which bank?" }).finally(() => {
      settled = true;
    });
    await until(() => h.events().some((e) => e.type === "ask.request"));
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.body.ok).toBe(false);
    expect(JSON.stringify(result.body.content)).toContain("within 60 minutes");
    expect(h.events().find((e) => e.type === "ask.answer")?.data).toMatchObject({ by: "timeout" });
  });

  it("an attended task keeps the default card window", async () => {
    const h = toolHarness({ autoApprove: false });
    harnesses.push(h);
    expect(h.session.unattended).toBe(false);
    expect(h.session.run).toBeUndefined();
    const before = Date.now();
    void h.call("shell", { command: "ls" });
    await vi.waitFor(() => expect(h.session.pendingApproval).toBeDefined());
    expect(h.session.pendingApproval?.expiresAt).toBeGreaterThanOrEqual(
      before + APPROVAL_TIMEOUT_MS,
    );
    h.session.stop();
  });

  it("refuses a window outside 1 minute to 4 hours and keeps the run description", () => {
    const home = mkdtempSync(join(tmpdir(), "ld-unattended-"));
    const log = new EventLog(home);
    try {
      for (const approvalTtlMs of [59_999, 14_400_001, 1.5])
        expect(
          () => new AgentSession(ulid(), ulid(), "t", log, undefined, undefined, { approvalTtlMs }),
        ).toThrow(RangeError);
      const run = {
        kind: "routine" as const,
        name: "Morning bills",
        profile: "ask_first" as const,
        approvalWindowMinutes: 60,
      };
      expect(
        new AgentSession(ulid(), ulid(), "t", log, undefined, undefined, {
          approvalTtlMs: 3_600_000,
          run,
        }).run,
      ).toEqual(run);
    } finally {
      log.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
