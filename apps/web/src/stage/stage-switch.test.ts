// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginSwitch,
  type StageSwitch,
  SWITCH_SLOW_MS,
  type SwitchSight,
  stepSwitch,
  switchTimedOut,
  useStageSwitch,
} from "./stage-switch.ts";

const TO = "01JXYZ0000000000000000CONV";
const sight = (seen: Partial<SwitchSight> = {}): SwitchSight => ({
  settled: false,
  presented: false,
  yielded: false,
  ...seen,
});
const covering: StageSwitch = { to: TO, title: "Plan a picnic", phase: "covering", turn: 1 };
const pending: StageSwitch = { ...covering, phase: "pending" };

afterEach(() => {
  vi.useRealTimers();
});

describe("beginSwitch", () => {
  it("covers the stage unless the conversation shows the picture already on it", () => {
    expect(beginSwitch(null, TO, "Plan a picnic", false, 1)).toEqual(covering);
    expect(beginSwitch(null, TO, "Plan a picnic", true, 1)).toEqual(pending);
    expect(beginSwitch(null, null, "New conversation", true, 2)).toEqual({
      to: null,
      title: "New conversation",
      phase: "pending",
      turn: 2,
    });
  });

  it("keeps a loading state already up while the user takes up yet another conversation", () => {
    const next = beginSwitch(covering, "01JXYZ0000000000000000NEXT", "Book a table", true, 2);
    expect(next).toEqual({
      to: "01JXYZ0000000000000000NEXT",
      title: "Book a table",
      phase: "covering",
      turn: 2,
    });
    expect(beginSwitch({ ...covering, phase: "slow" }, TO, "Plan a picnic", true, 3).phase).toBe(
      "covering",
    );
    expect(beginSwitch(pending, TO, "Plan a picnic", true, 3).phase).toBe("pending");
  });
});

describe("stepSwitch", () => {
  it("holds the loading state until the conversation is settled and its screen presented", () => {
    expect(stepSwitch(covering, sight())).toBe(covering);
    // A picture presented before the conversation is on show is the one left behind.
    expect(stepSwitch(covering, sight({ presented: true }))).toBe(covering);
    // Settled on a screen whose frames are still on their way.
    expect(stepSwitch(covering, sight({ settled: true }))).toBe(covering);
    expect(stepSwitch(covering, sight({ settled: true, presented: true }))).toBeNull();
    expect(
      stepSwitch({ ...covering, phase: "slow" }, sight({ settled: true, presented: true })),
    ).toBeNull();
  });

  it("skips the loading state when the picture on the stage is the conversation's own", () => {
    expect(stepSwitch(pending, sight())).toBe(pending);
    expect(stepSwitch(pending, sight({ settled: true, presented: true }))).toBeNull();
  });

  it("covers at once when a conversation expected to keep the picture brings another screen", () => {
    expect(stepSwitch(pending, sight({ settled: true }))).toEqual({
      ...pending,
      phase: "covering",
    });
  });

  it("gives way to the curtain, Replay or a stage out of sight", () => {
    for (const state of [pending, covering, { ...covering, phase: "slow" as const }])
      expect(stepSwitch(state, sight({ yielded: true }))).toBeNull();
    expect(stepSwitch(null, sight({ settled: true, presented: true }))).toBeNull();
  });
});

describe("switchTimedOut", () => {
  it("says a screen that never came is late, and lets an unseen wait go", () => {
    expect(switchTimedOut(covering)).toEqual({ ...covering, phase: "slow" });
    const slow = { ...covering, phase: "slow" as const };
    expect(switchTimedOut(slow)).toBe(slow);
    expect(switchTimedOut(pending)).toBeNull();
    expect(switchTimedOut(null)).toBeNull();
  });
});

describe("useStageSwitch", () => {
  it("times a loading state that never ends out to the late message, from its own start", () => {
    vi.useFakeTimers();
    const seen = { current: sight() };
    const { result, rerender } = renderHook(() => {
      const control = useStageSwitch();
      return { ...control, state: control.see(seen.current) };
    });
    expect(result.current.state).toBeNull();
    act(() => result.current.begin(TO, "Plan a picnic", false));
    expect(result.current.state?.phase).toBe("covering");
    act(() => {
      vi.advanceTimersByTime(SWITCH_SLOW_MS - 1000);
    });
    // Another conversation taken up meanwhile starts the wait again.
    act(() => result.current.begin("01JXYZ0000000000000000NEXT", "Book a table", false));
    act(() => {
      vi.advanceTimersByTime(SWITCH_SLOW_MS - 1);
    });
    expect(result.current.state?.phase).toBe("covering");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.state).toMatchObject({ phase: "slow", title: "Book a table" });
    // The screen still arriving takes the message away; so does the user.
    seen.current = sight({ settled: true, presented: true });
    rerender();
    expect(result.current.state).toBeNull();
    seen.current = sight();
    act(() => result.current.begin(TO, "Plan a picnic", false));
    act(() => {
      vi.advanceTimersByTime(SWITCH_SLOW_MS);
    });
    expect(result.current.state?.phase).toBe("slow");
    act(() => result.current.end());
    expect(result.current.state).toBeNull();
  });

  it("lets a wait for a picture that stayed go quietly", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => {
      const control = useStageSwitch();
      return { ...control, state: control.see(sight()) };
    });
    act(() => result.current.begin(TO, "Plan a picnic", true));
    expect(result.current.state?.phase).toBe("pending");
    act(() => {
      vi.advanceTimersByTime(SWITCH_SLOW_MS);
    });
    expect(result.current.state).toBeNull();
  });
});
