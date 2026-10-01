import { describe, expect, it } from "vitest";
import { AvatarController, type ControllerOptions } from "./controller.ts";
import type { AvatarParams } from "./params.ts";
import { prepareTrack } from "./speech.ts";
import { GazeWander, type Look } from "./wander.ts";

const FRAME_MS = 16;

// Steps a fake clock in display frames, calling frame() each time, as the UI's rAF loop does.
const make = (options: Partial<ControllerOptions> = {}) => {
  let now = 0;
  const avatar = new AvatarController(
    { seed: 1, headCenter: { x: 0, y: 0 }, reach: 500, ...options },
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
    // Reduced motion removes the sway and leaves the gaze alone.
    const { avatar, run } = make({ reducedMotion: true });
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

  it("wanders through its seed's looks when nothing holds attention, glancing at the user", () => {
    const { run } = make();
    const looks = new GazeWander(1).looksUntil(30_000);
    expect(looks.slice(1).some((look) => look.x === 0 && look.y === 0)).toBe(true);
    for (const look of looks.slice(0, -1)) {
      const p = run(look.at + 400);
      expect(p.eyeX).toBeCloseTo(look.x, 2);
      expect(p.eyeY).toBeCloseTo(look.y, 2);
    }
  });

  it("keeps wandering under reduced motion, eyes first and the head after", () => {
    const { avatar, run } = make();
    avatar.setReducedMotion(true);
    const looks = new GazeWander(1).looksUntil(30_000);
    for (const [i, look] of looks.slice(1, -1).entries()) {
      const before = looks[i] as Look;
      const progress = (value: number, share: number) =>
        (value - before.x * share) / ((look.x - before.x) * share);
      const early = run(look.at + 60);
      expect(progress(early.eyeX, 1)).toBeGreaterThan(0.8);
      expect(progress(early.headX, 0.36)).toBeLessThan(0.4);
      const settled = run(look.at + 900);
      expect(settled.headX).toBeCloseTo(look.x * 0.36, 2);
      expect(settled.headY).toBeCloseTo(look.y * 0.36, 2);
    }
  });

  it("turns to a point at once and back to the wander smoothly once attention lapses", () => {
    const { avatar, run } = make();
    const looks = new GazeWander(1).looksUntil(60_000);
    const look = looks.find(
      (l, i) => l.at > 2000 && l.x !== 0 && ((looks[i + 1] as Look).at ?? 0) - l.at > 3000,
    ) as Look;
    run(look.at - 500);
    avatar.setAttention({ x: 400, y: 0 });
    expect(run(look.at - 400).eyeX).toBeCloseTo(0.8, 1);
    expect(run(look.at + 1000).eyeX).toBeCloseTo(0.8, 2);
    avatar.setAttention(null);
    let previous = run(look.at + 1000);
    for (let t = look.at + 1000 + FRAME_MS; t <= look.at + 2500; t += FRAME_MS) {
      const p = run(t);
      expect(Math.abs(p.headX - previous.headX)).toBeLessThan(0.03);
      previous = p;
    }
    expect(run(look.at + 2500).eyeX).toBeCloseTo(look.x, 2);
  });

  it("keeps the gaze a state sets itself: aside while thinking, on the user while waiting", () => {
    for (const [state, eyeX, eyeY] of [
      ["thinking", -0.4, 0.5],
      ["waiting_user", 0, 0],
    ] as const) {
      const { avatar, run } = make();
      avatar.setState(state);
      for (let t = 1500; t <= 20_000; t += 250) {
        const p = run(t);
        expect(p.eyeX).toBeCloseTo(eyeX, 2);
        expect(p.eyeY).toBeCloseTo(eyeY, 2);
      }
    }
  });

  it("faces the user when attention is on them instead of wandering", () => {
    const { avatar, run } = make();
    avatar.setAttention("user");
    for (let t = 0; t <= 20_000; t += 250) {
      const p = run(t);
      expect(p.eyeX).toBeCloseTo(0, 3);
      expect(p.eyeY).toBeCloseTo(0, 3);
    }
  });

  it("sways, leans and rolls while facing the user, easing in from a still first frame", () => {
    const SWAYED = ["headX", "headY", "bodyX", "headRoll", "wind"] as const;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { avatar, run } = make({ seed });
      avatar.setAttention("user");
      let previous = run(0);
      for (const key of SWAYED) expect(previous[key]).toBeCloseTo(0, 9);
      const peak = { headX: 0, headY: 0, bodyX: 0, headRoll: 0, wind: 0 };
      for (let t = FRAME_MS; t <= 60_000; t += FRAME_MS) {
        const p = run(t);
        for (const key of SWAYED) {
          expect(Math.abs((p[key] ?? 0) - (previous[key] ?? 0))).toBeLessThan(0.03);
          peak[key] = Math.max(peak[key], Math.abs(p[key] ?? 0));
        }
        previous = p;
      }
      expect(peak.headX).toBeGreaterThan(0.08);
      expect(peak.headY).toBeGreaterThan(0.05);
      expect(peak.bodyX).toBeGreaterThan(0.08);
      expect(peak.headRoll).toBeGreaterThan(0.5);
      expect(peak.wind).toBeGreaterThan(0.6);
    }
  });

  it("tilts the head toward the side she looks", () => {
    const meanRoll = (x: number) => {
      const { avatar, run } = make({ seed: 3 });
      avatar.setAttention({ x, y: 0 });
      let sum = 0;
      let frames = 0;
      for (let t = 2000; t <= 30_000; t += 100) {
        sum += run(t).headRoll ?? 0;
        frames++;
      }
      return sum / frames;
    };
    const right = meanRoll(400);
    const left = meanRoll(-400);
    expect(right - left).toBeGreaterThan(0.3);
    expect(right).toBeGreaterThan(0);
    expect(left).toBeLessThan(0);
  });

  it("stops the sway under reduced motion and eases it back in afterwards", () => {
    const { avatar, run } = make({ seed: 2, reducedMotion: true });
    avatar.setAttention("user");
    for (let t = 0; t <= 10_000; t += FRAME_MS) {
      const p = run(t);
      expect([p.headX, p.headY, p.bodyX, p.headRoll, p.wind]).toEqual([0, 0, 0, 0, 0]);
    }
    let previous = run(10_000);
    avatar.setReducedMotion(false);
    for (let t = 10_000 + FRAME_MS; t <= 14_000; t += FRAME_MS) {
      const p = run(t);
      for (const key of ["headX", "headY", "bodyX", "headRoll", "wind"] as const) {
        expect(Math.abs((p[key] ?? 0) - (previous[key] ?? 0))).toBeLessThan(0.03);
      }
      previous = p;
    }
  });

  const LIFE = ["headX", "headY", "bodyX", "headRoll", "wind", "breath"] as const;
  const step = (a: AvatarParams, b: AvatarParams) =>
    Math.max(...LIFE.map((key) => Math.abs((a[key] ?? 0) - (b[key] ?? 0))));

  it("eases the sway, roll, lean, breath and breeze out when reduced motion comes on", () => {
    for (const seed of [1, 7, 247]) {
      for (const onAt of [4000, 9008, 15008]) {
        const { avatar, run } = make({ seed });
        avatar.setAttention("user");
        let previous = run(onAt);
        avatar.setReducedMotion(true);
        for (let t = onAt + FRAME_MS; t <= onAt + 2000; t += FRAME_MS) {
          const p = run(t);
          expect(step(p, previous)).toBeLessThan(0.03);
          previous = p;
        }
        const settled = run(onAt + 1200);
        for (const key of LIFE) expect(Math.abs(settled[key] ?? 0)).toBeLessThan(0.05);
      }
    }
  });

  it("never pops when reduced motion flips on and back off", () => {
    for (const seed of [1, 7, 247]) {
      for (const onAt of [4000, 9008, 15008]) {
        const { avatar, run } = make({ seed });
        avatar.setAttention("user");
        let previous = run(onAt);
        avatar.setReducedMotion(true);
        for (let t = onAt + FRAME_MS; t <= onAt + 3000; t += FRAME_MS) {
          if (t === onAt + 304) avatar.setReducedMotion(false);
          const p = run(t);
          expect(step(p, previous)).toBeLessThan(0.03);
          previous = p;
        }
      }
    }
  });

  it("keeps idle sway and wander inside the gaze's head range and the wander's eye range", () => {
    for (const seed of [1, 2, 3, 4]) {
      const { run } = make({ seed });
      for (let t = 0; t <= 300_000; t += 48) {
        const p = run(t);
        expect(Math.abs(p.headX)).toBeLessThanOrEqual(0.36);
        expect(Math.abs(p.headY)).toBeLessThanOrEqual(0.36);
        expect(Math.abs(p.eyeX)).toBeLessThanOrEqual(0.6);
        expect(Math.abs(p.eyeY)).toBeLessThanOrEqual(0.3);
        expect(Math.abs(p.bodyX)).toBeLessThanOrEqual(0.12);
        expect(Math.abs(p.headRoll ?? 0)).toBeLessThanOrEqual(0.95);
      }
    }
  });

  it("keeps the sway on top of a full turn inside the head limit", () => {
    for (const seed of [1, 2, 3, 4]) {
      for (const far of [-10_000, 10_000]) {
        const { avatar, run } = make({ seed });
        avatar.setAttention({ x: far, y: -far });
        for (let t = 0; t <= 60_000; t += 48) {
          const p = run(t);
          expect(Math.abs(p.headX)).toBeLessThanOrEqual(0.6);
          expect(Math.abs(p.headY)).toBeLessThanOrEqual(0.6);
        }
      }
    }
  });

  it("faces the user while speaking, holds 0.8 s after the last syllable, then wanders again", () => {
    const { avatar, run } = make();
    const looks = new GazeWander(1).looksUntil(60_000);
    const look = looks.find(
      (l, i) => l.at > 2000 && l.x !== 0 && ((looks[i + 1] as Look).at ?? 0) - l.at > 3000,
    ) as Look;
    run(look.at + 300);
    avatar.speak(
      prepareTrack({
        lang: "en",
        startsAt: look.at + 500,
        visemes: [
          { t: 0, shape: "A" },
          { t: 1000, shape: "rest" },
        ],
      }),
    );
    expect(run(look.at + 300).eyeX).toBeCloseTo(look.x, 2);
    for (let t = look.at + 600; t <= look.at + 1500 + 790; t += FRAME_MS) {
      expect(run(t).eyeX).toBeCloseTo(0, 2);
    }
    let previous = run(look.at + 2300);
    for (let t = look.at + 2300 + FRAME_MS; t <= look.at + 2900; t += FRAME_MS) {
      const p = run(t);
      expect(Math.abs(p.headX - previous.headX)).toBeLessThan(0.03);
      previous = p;
    }
    expect(previous.eyeX).toBeCloseTo(look.x, 2);
  });

  it("lets approval, a pointer or a target win over speech, but not the lower sources", () => {
    const speaking = () => {
      const made = make({ reducedMotion: true });
      made.avatar.speak(
        prepareTrack({
          lang: "en",
          startsAt: 0,
          visemes: [
            { t: 0, shape: "A" },
            { t: 5000, shape: "rest" },
          ],
        }),
      );
      return made;
    };
    for (const source of ["pointer", "target"] as const) {
      const { avatar, run } = speaking();
      avatar.setAttention({ x: 400, y: 0 }, source);
      expect(run(1000).eyeX).toBeCloseTo(0.8, 2);
    }
    for (const source of ["cursor", "changed", "input"] as const) {
      const { avatar, run } = speaking();
      avatar.setAttention({ x: 400, y: 0 }, source);
      expect(run(1000).eyeX).toBeCloseTo(0, 2);
    }
    const { avatar, run } = speaking();
    avatar.setAttention("user", "approval");
    expect(run(1000).eyeX).toBeCloseTo(0, 2);
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
      for (const key of ["headX", "headY", "bodyX", "eyeX", "eyeY", "brow", "headRoll"] as const) {
        expect(Number.isFinite(p[key])).toBe(true);
        expect(Math.abs(p[key] ?? Number.NaN)).toBeLessThanOrEqual(1);
      }
      for (const key of ["eyeOpenL", "eyeOpenR", "mouthOpen", "breath", "blush"] as const) {
        expect(p[key]).toBeGreaterThanOrEqual(0);
        expect(p[key]).toBeLessThanOrEqual(1);
      }
    }
  });
});
