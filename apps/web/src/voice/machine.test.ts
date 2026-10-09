import { describe, expect, it } from "vitest";
import {
  AWAY_PX,
  awayFrom,
  IDLE,
  RETURN_PX,
  TAP_MS,
  type VoiceEvent,
  type VoiceState,
  voiceStep,
} from "./machine.ts";

function run(events: readonly VoiceEvent[], from: VoiceState = IDLE) {
  let state = from;
  const effects: string[] = [];
  for (const event of events) {
    const step = voiceStep(state, event);
    state = step.state;
    if (step.effect) effects.push(step.effect);
  }
  return { state, effects };
}

describe("push to talk", () => {
  it("holds to talk and lets go to finish", () => {
    const { state, effects } = run([
      { type: "press", at: 0 },
      { type: "started", at: 120 },
      { type: "release", at: 2000 },
    ]);
    expect(state).toEqual({ phase: "finishing" });
    expect(effects).toEqual(["start", "finish"]);
    expect(run([{ type: "done" }], state)).toEqual({ state: IDLE, effects: [] });
  });

  it("listens on after a tap until the next tap", () => {
    const tapped = run([
      { type: "press", at: 0 },
      { type: "started", at: 80 },
      { type: "release", at: TAP_MS - 1 },
    ]);
    expect(tapped.state).toMatchObject({ phase: "listening", held: false });
    expect(tapped.effects).toEqual(["start"]);
    const again = run(
      [
        { type: "press", at: 5000 },
        { type: "release", at: 5100 },
      ],
      tapped.state,
    );
    expect(again).toEqual({ state: { phase: "finishing" }, effects: ["finish"] });
  });

  it("keeps listening when let go before the mic is ready, as on the first permission prompt", () => {
    const { state } = run([
      { type: "press", at: 0 },
      { type: "release", at: 3000 },
      { type: "started", at: 3500 },
    ]);
    expect(state).toEqual({ phase: "listening", held: false, away: false, at: 0, since: 3500 });
  });

  it("cancels when let go away from the mic, and not after coming back", () => {
    const away = run([
      { type: "press", at: 0 },
      { type: "started", at: 50 },
      { type: "away", away: true },
      { type: "release", at: 2000 },
    ]);
    expect(away).toEqual({ state: IDLE, effects: ["start", "abort"] });
    const back = run([
      { type: "press", at: 0 },
      { type: "started", at: 50 },
      { type: "away", away: true },
      { type: "away", away: false },
      { type: "release", at: 2000 },
    ]);
    expect(back.effects).toEqual(["start", "finish"]);
    const early = run([
      { type: "press", at: 0 },
      { type: "away", away: true },
      { type: "release", at: 900 },
    ]);
    expect(early).toEqual({ state: IDLE, effects: ["start", "abort"] });
  });

  it("ignores sliding while it listens on by itself", () => {
    const latched: VoiceState = { phase: "listening", held: false, away: false, at: 0, since: 10 };
    expect(voiceStep(latched, { type: "away", away: true }).state).toBe(latched);
    expect(voiceStep(latched, { type: "release", at: 99 }).state).toBe(latched);
  });

  it("drops the turn on cancel, a failure or a second tap before it started", () => {
    const listening: VoiceState = { phase: "listening", held: true, away: false, at: 0, since: 1 };
    expect(voiceStep(listening, { type: "cancel" })).toEqual({ state: IDLE, effect: "abort" });
    expect(voiceStep(listening, { type: "done" })).toEqual({ state: IDLE, effect: "abort" });
    expect(voiceStep({ phase: "finishing" }, { type: "cancel" })).toEqual({
      state: IDLE,
      effect: "abort",
    });
    const starting: VoiceState = { phase: "starting", held: false, away: false, at: 0 };
    expect(voiceStep(starting, { type: "press", at: 10 })).toEqual({
      state: IDLE,
      effect: "abort",
    });
    expect(voiceStep(IDLE, { type: "cancel" }).state).toBe(IDLE);
  });

  it("finishes on its own at the longest recording", () => {
    const listening: VoiceState = { phase: "listening", held: true, away: false, at: 0, since: 1 };
    expect(voiceStep(listening, { type: "stop" })).toEqual({
      state: { phase: "finishing" },
      effect: "finish",
    });
    expect(voiceStep(IDLE, { type: "stop" }).state).toBe(IDLE);
  });
});

describe("sliding away", () => {
  const mic = { left: 100, top: 100, right: 128, bottom: 128 };
  it("arms past AWAY_PX and disarms within RETURN_PX", () => {
    expect(awayFrom(mic, 128 + AWAY_PX - 1, 110, false)).toBe(false);
    expect(awayFrom(mic, 128 + AWAY_PX + 1, 110, false)).toBe(true);
    expect(awayFrom(mic, 128 + RETURN_PX + 5, 110, true)).toBe(true);
    expect(awayFrom(mic, 128 + RETURN_PX - 1, 110, true)).toBe(false);
    expect(awayFrom(mic, 114, 100 - AWAY_PX - 1, false)).toBe(true);
  });
});
