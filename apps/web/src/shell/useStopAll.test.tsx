// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { stoppedText, useStopAll } from "./useStopAll.ts";

const done = {
  sessions: [
    {
      sessionId: "01J00000000000000000000001",
      cellId: "01J00000000000000000000002",
      outcome: { revoked: true, paused: true, closed: false, stopped: false, errors: [] },
    },
  ],
  cells: [],
  routinesPaused: 2,
  launchesCancelled: 0,
  confirmed: true,
};

function fixture(stopAll: () => Promise<typeof done>) {
  const api = { stopAll: vi.fn(stopAll), resume: vi.fn(async () => ({ resumed: 2 })) };
  const toast = vi.fn();
  const hook = renderHook(() => useStopAll(api, toast));
  return { api, toast, hook };
}

describe("Stop everything", () => {
  it("says what stopped, then offers to continue the paused routines", async () => {
    const f = fixture(async () => done);
    await act(() => f.hook.result.current.run());
    const shown = f.toast.mock.calls[0]?.[0];
    expect(shown).toMatchObject({
      title: "Everything stopped",
      description: "1 task stopped, 2 routines paused.",
      action: { label: "Continue routines" },
    });
    await act(async () => shown.action.onAction());
    expect(f.api.resume).toHaveBeenCalledTimes(1);
    expect(f.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Routines are running again" }),
    );
  });
  it("offers nothing to continue when no routine was paused", async () => {
    const f = fixture(async () => ({ ...done, routinesPaused: 0 }));
    await act(() => f.hook.result.current.run());
    expect(f.toast.mock.calls[0]?.[0].action).toBeUndefined();
  });
  it.each([
    ["unconfirmed", async () => ({ ...done, confirmed: false })],
    [
      "refused",
      async () => {
        throw new Error("503");
      },
    ],
  ])("warns until it is confirmed when the stop is %s, and checks again", async (_name, reply) => {
    const f = fixture(reply as () => Promise<typeof done>);
    await act(() => f.hook.result.current.run());
    const shown = f.toast.mock.calls[0]?.[0];
    expect(shown).toMatchObject({
      title: "Couldn't confirm that everything stopped",
      tone: "danger",
      action: { label: "Check again" },
    });
    await act(async () => shown.action.onAction());
    await vi.waitFor(() => expect(f.api.stopAll).toHaveBeenCalledTimes(2));
  });
  it("shares one stop between presses that overlap", async () => {
    let finish!: (value: typeof done) => void;
    const f = fixture(() => new Promise((resolve) => (finish = resolve)));
    let first!: Promise<void>, second!: Promise<void>;
    act(() => {
      first = f.hook.result.current.run();
      second = f.hook.result.current.run();
    });
    expect(f.api.stopAll).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(done);
      await Promise.all([first, second]);
    });
    expect(f.toast).toHaveBeenCalledTimes(1);
  });
  it("words an outcome with nothing running", () => {
    expect(stoppedText({ ...done, sessions: [], routinesPaused: 0 })).toBe("Nothing was running.");
    expect(
      stoppedText({
        ...done,
        cells: [
          {
            cellId: "01J00000000000000000000003",
            outcome: done.sessions[0]?.outcome as never,
          },
        ],
        routinesPaused: 1,
      }),
    ).toBe("1 task stopped, 1 computer frozen, 1 routine paused.");
  });
});
