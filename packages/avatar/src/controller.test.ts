import { describe, expect, it } from "vitest";
import { AvatarController } from "./controller.ts";
import type { AvatarParams } from "./params.ts";
import { prepareTrack } from "./speech.ts";

const FRAME_MS = 16;

// Steps a fake clock in display frames, calling frame() each time, as the UI's rAF loop does.
const make = () => {
  let now = 0;
  const avatar = new AvatarController(
    { seed: 1, headCenter: { x: 0, y: 0 }, reach: 500 },
    () => now,
  );
  const run = (toMs: number): AvatarParams => {
    let p = avatar.frame();
    while (now < toMs) {
      now = Math.min(toMs, now + FRAME_MS);
      p = avatar.frame();
    }
    return p;
  };
  return { avatar, run };
};

describe("AvatarController", () => {
  it("starts neutral with eyes open and mouth at rest", () => {
    const { run } = make();
    const p = run(0);
    expect(p.headX).toBeCloseTo(0, 1);
    expect(p.mouthShape).toBe("rest");
    expect(p.eyeOpenL).toBeGreaterThan(0.9);
  });

  it("moves the eyes to a target before the head", () => {
    const { avatar, run } = make();
    avatar.setAttention({ x: 400, y: 0 });
    const early = run(60);
    expect(early.eyeX).toBeGreaterThan(0.6 * 0.8);
    expect(early.headX).toBeLessThan(0.5 * 0.288);
    const settled = run(1500);
    expect(settled.eyeX).toBeCloseTo(0.8, 1);
    expect(settled.headX).toBeCloseTo(0.288, 1);
  });

  it("follows a target that moves every frame without jumps", () => {
    const { avatar, run } = make();
    let previous = run(0);
    for (let t = FRAME_MS; t <= 4000; t += FRAME_MS) {
      avatar.setAttention({ x: 400 * Math.cos(t / 300), y: 400 * Math.sin(t / 300) });
      const p = run(t);
      expect(Math.abs(p.eyeX - previous.eyeX)).toBeLessThan(0.4);
      expect(Math.abs(p.headX - previous.headX)).toBeLessThan(0.05);
      previous = p;
    }
  });

  it("looks up and to the side while thinking", () => {
    const { avatar, run } = make();
    avatar.setState("thinking");
    const p = run(1500);
    expect(p.eyeY).toBeGreaterThan(0.3);
    expect(p.eyeX).toBeLessThan(-0.2);
  });

  it("adds a thinking expression after five seconds", () => {
    const { avatar, run } = make();
    avatar.setState("thinking");
    expect(run(4000).expressions.hmm ?? 0).toBe(0);
    expect(run(6500).expressions.hmm ?? 0).toBeGreaterThan(0.3);
  });

  it("moves the mouth with a speech track", () => {
    const { avatar, run } = make();
    avatar.speak(
      prepareTrack({
        lang: "en",
        startsAt: 0,
        visemes: [
          { t: 0, shape: "A" },
          { t: 300, shape: "rest" },
        ],
      }),
    );
    expect(run(100).mouthShape).toBe("A");
    expect(run(500).mouthShape).toBe("rest");
  });

  it("removes breathing, sway and body motion under reduced motion but keeps gaze", () => {
    const { avatar, run } = make();
    avatar.setReducedMotion(true);
    avatar.react("hmph");
    avatar.setAttention({ x: 400, y: 0 });
    const during = run(300);
    expect(during.bodyX).toBe(0);
    expect(during.breath).toBe(0);
    const later = run(2000);
    expect(later.eyeX).toBeGreaterThan(0.5);
  });

  it("applies mood weights and clears them when speech ends", () => {
    const { avatar, run } = make();
    avatar.setMood("smug", 1);
    expect(run(1500).expressions.smug ?? 0).toBeGreaterThan(0.9);
    avatar.speak(null);
    expect(run(3000).expressions.smug ?? 0).toBeLessThan(0.05);
  });

  it("closes the mouth after a malformed track that skipped preparation", () => {
    const { avatar, run } = make();
    avatar.speak({
      lang: "en",
      startsAt: 0,
      visemes: [
        { t: 0, shape: "A" },
        { t: Number.NaN, shape: "A" },
      ],
    });
    expect(run(5000)).toMatchObject({ mouthShape: "rest", mouthOpen: 0 });
  });

  it("fades a reply's mood once its speech has finished", () => {
    const { avatar, run } = make();
    avatar.setMood("smug", 1);
    avatar.speak(
      prepareTrack({
        lang: "en",
        startsAt: 0,
        visemes: [
          { t: 0, shape: "A" },
          { t: 300, shape: "rest" },
        ],
      }),
    );
    expect(run(500).expressions.smug ?? 0).toBeGreaterThan(0.5);
    expect(run(2000).expressions.smug ?? 0).toBeLessThan(0.05);
  });

  it("fades a mood set without speech after a few seconds", () => {
    const { avatar, run } = make();
    avatar.setMood("smug", 1);
    expect(run(3000).expressions.smug ?? 0).toBeGreaterThan(0.9);
    expect(run(6000).expressions.smug ?? 0).toBeLessThan(0.05);
  });

  it("keeps every parameter finite and in range under random input", () => {
    const { avatar, run } = make();
    const states = [
      "idle",
      "thinking",
      "acting",
      "observing",
      "waiting_user",
      "paused",
      "error",
      "done",
    ] as const;
    const reactions = ["nod", "wince", "cheer", "hmph", "surprise", "blush"] as const;
    let t = 0;
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 2000; i++) {
      t += rnd() * 40;
      const pick = rnd();
      if (pick < 0.2)
        avatar.setState(states[Math.floor(rnd() * states.length)] as (typeof states)[number]);
      else if (pick < 0.4)
        avatar.setAttention(
          rnd() < 0.1
            ? { x: Number.NaN, y: 0 }
            : { x: rnd() * 4000 - 2000, y: rnd() * 4000 - 2000 },
        );
      else if (pick < 0.5)
        avatar.react(reactions[Math.floor(rnd() * reactions.length)] as (typeof reactions)[number]);
      else if (pick < 0.55) avatar.setReducedMotion(rnd() < 0.5);
      const p = run(t);
      for (const key of ["headX", "headY", "bodyX", "eyeX", "eyeY", "brow"] as const) {
        expect(Number.isFinite(p[key])).toBe(true);
        expect(Math.abs(p[key])).toBeLessThanOrEqual(1);
      }
      for (const key of ["eyeOpenL", "eyeOpenR", "mouthOpen", "breath", "blush"] as const) {
        expect(p[key]).toBeGreaterThanOrEqual(0);
        expect(p[key]).toBeLessThanOrEqual(1);
      }
    }
  });
});
