import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkClock } from "./work-clock.ts";

function fakeSession() {
  const waits = { approval: false, control: false, question: false };
  return {
    waits,
    session: {
      get pendingApproval() {
        return waits.approval ? ({} as never) : undefined;
      },
      get controlHeld() {
        return waits.control;
      },
      get pendingAsk() {
        return waits.question ? "ask" : undefined;
      },
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("the work clock", () => {
  it("aborts a call after two minutes of work", async () => {
    vi.useFakeTimers();
    const clock = startWorkClock(fakeSession().session, "computer", {});
    await vi.advanceTimersByTimeAsync(119_999);
    expect(clock?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(clock?.signal.aborted).toBe(true);
    expect(clock?.expired).toBe(true);
  });

  it.each(["approval", "control", "question"] as const)(
    "does not count the time the task waits on the user's %s",
    async (wait) => {
      vi.useFakeTimers();
      const { session, waits } = fakeSession();
      const clock = startWorkClock(session, "files", { op: "read", path: "a" });
      await vi.advanceTimersByTimeAsync(60_000);
      waits[wait] = true;
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(clock?.signal.aborted).toBe(false);
      waits[wait] = false;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(clock?.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(clock?.signal.aborted).toBe(true);
    },
  );

  it("gives a command its own timeout plus ten seconds", async () => {
    vi.useFakeTimers();
    const { session } = fakeSession();
    const short = startWorkClock(session, "shell", { command: "sleep 1", timeout_sec: 30 });
    const standard = startWorkClock(session, "shell", { command: "sleep 1" });
    await vi.advanceTimersByTimeAsync(39_999);
    expect(short?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(short?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(standard?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(standard?.signal.aborted).toBe(true);
  });

  it("leaves the model's questions and hand-off requests to their own limits", () => {
    const { session } = fakeSession();
    expect(startWorkClock(session, "ask_user", {})).toBeUndefined();
    expect(startWorkClock(session, "request_takeover", {})).toBeUndefined();
  });

  it("stops counting once the call ends", async () => {
    vi.useFakeTimers();
    const clock = startWorkClock(fakeSession().session, "update_plan", {});
    clock?.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(clock?.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
