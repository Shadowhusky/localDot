import { describe, expect, it } from "vitest";
import { MIN_HOLD_MS, STATE_POSES, StateGate } from "./states.ts";

describe("StateGate", () => {
  it("switches immediately after the current state has been held long enough", () => {
    const gate = new StateGate("idle", 0);
    gate.request("thinking", 1000);
    expect(gate.current(1000)).toBe("thinking");
  });

  it("never changes more than once per 250 ms and ends on the last request", () => {
    const gate = new StateGate("idle", 0);
    gate.request("thinking", 1000);
    const requests = ["acting", "observing", "acting", "error", "acting"] as const;
    for (const [i, s] of requests.entries()) gate.request(s, 1010 + i * 20);
    const seen: { t: number; s: string }[] = [];
    let previous = gate.current(1000);
    for (let t = 1000; t <= 2000; t += 5) {
      const s = gate.current(t);
      if (s !== previous) seen.push({ t, s });
      previous = s;
    }
    expect(seen.map((x) => x.s)).toEqual(["acting"]);
    expect(seen[0]?.t).toBeGreaterThanOrEqual(1000 + MIN_HOLD_MS);
  });

  it("cancels a pending change when the current state is requested again", () => {
    const gate = new StateGate("idle", 0);
    gate.request("acting", 1000);
    gate.request("thinking", 1100);
    gate.request("acting", 1150);
    expect(gate.current(1500)).toBe("acting");
  });

  it("reports how long the current state has been held", () => {
    const gate = new StateGate("idle", 0);
    gate.request("thinking", 1000);
    expect(gate.heldFor(6000)).toBe(5000);
  });

  it("has a pose for every agent state", () => {
    for (const state of [
      "idle",
      "thinking",
      "acting",
      "observing",
      "waiting_user",
      "paused",
      "error",
      "done",
    ] as const) {
      expect(STATE_POSES[state]).toBeDefined();
    }
  });
});
