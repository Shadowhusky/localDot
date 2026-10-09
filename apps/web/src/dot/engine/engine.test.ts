import { mulberry32, springValue } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { LOD_DETAIL } from "../render/lod.ts";
import { Channel } from "./channel.ts";
import { DotEngine, type DotEngineOptions, type DotPose } from "./engine.ts";
import { settleMs, springVelocity } from "./spring.ts";
import { SPRINGS, STATE_HOLD_MS, STATE_NAMES, spring } from "./states.ts";

type Input = [t: number, kind: "state" | "react" | "pointer", arg: unknown];

// A scripted session through every state, with pointer input and reactions.
const TIMELINE: Input[] = [
  [0, "state", "idle"],
  [3000, "state", "listening"],
  [5200, "state", "thinking"],
  [11800, "state", "acting"],
  [17000, "state", "observing"],
  [20000, "state", "speaking"],
  [24000, "state", "waiting"],
  [30000, "state", "your-turn"],
  [30500, "pointer", [3, 1]],
  [31200, "pointer", [-5, -2]],
  [31900, "pointer", [-5.4, -2.2]],
  [33000, "state", "error"],
  [36000, "state", "idle"],
  [36400, "react", "success"],
  [39000, "state", "resting"],
  [41000, "state", "error"],
  [44000, "state", "sleeping"],
  [48000, "state", "waking"],
  [51000, "state", "idle"],
  [55000, "state", "offline"],
];
const END = 58_000;
const PROBE_EVERY = 250;

const fingerprint = (p: DotPose) =>
  JSON.stringify(p, (_k, v) => (typeof v === "number" ? Math.round(v * 1e9) / 1e9 : v));

// Drives the session with frames spaced by step(), probing the pose every 250 ms of engine time.
// A probe that falls before an input is taken first, as a live host would have rendered it.
function drive(seed: number, step: () => number, opts: Partial<DotEngineOptions> = {}) {
  const e = new DotEngine({ seed, t: 0, state: "idle", lod: "hero", ...opts });
  const probes = new Map<number, string>();
  let next = 0;
  const probeUntil = (t: number) => {
    for (; next <= t; next += PROBE_EVERY) probes.set(next, fingerprint(e.pose(next)));
  };
  let i = 0;
  for (let t = 0; t <= END; t += step()) {
    for (let input = TIMELINE[i]; input && input[0] <= t; input = TIMELINE[++i]) {
      const [at, kind, arg] = input;
      probeUntil(at - 1);
      e.pose(at);
      if (kind === "state") e.setState(arg as never, at);
      else if (kind === "react") e.react(arg as never, at);
      else e.pointerAt(...(arg as [number, number]), at);
    }
    probeUntil(t);
    e.pose(t);
  }
  return probes;
}

const at60 = () => 1000 / 60;

describe("dot engine", () => {
  it("poses identically whatever the frame rate", () => {
    const rng = mulberry32(99);
    const steady = drive(42, at60);
    const jittered = drive(42, () => 3 + rng() * 120);
    expect(steady.size).toBe(232);
    let same = 0;
    for (const [t, pose] of steady) if (jittered.get(t) === pose) same++;
    expect(same).toBe(steady.size);
  });

  it("performs differently for another seed", () => {
    const a = drive(42, at60);
    const b = drive(43, at60);
    let differing = 0;
    for (const [t, pose] of a) if (b.get(t) !== pose) differing++;
    expect(differing).toBeGreaterThan(0.85 * a.size);
  });

  it("keeps every eye point well inside the body in every state", () => {
    for (const lod of ["hero", "badge"] as const) {
      const grow = LOD_DETAIL[lod].eyeScale;
      let worst = 0;
      for (const name of STATE_NAMES) {
        const e = new DotEngine({ seed: 7, t: 0, state: name, lod });
        for (let t = 0; t < 12_000; t += 20) {
          for (const eye of e.pose(t).eyes) {
            const r = (5.4 * eye.scale * grow) / 2;
            const h = 10 * eye.scale * eye.sy * grow;
            const f = eye.frame;
            for (let k = 0; k < 48; k++) {
              const ang = (k / 48) * Math.PI * 2;
              const u = r * Math.cos(ang);
              const along = r * Math.sin(ang);
              const v = along + Math.sign(along) * (h / 2 - r);
              worst = Math.max(
                worst,
                Math.hypot(f.cx + f.a * u + f.c * v, f.cy + f.b * u + f.d * v),
              );
            }
          }
        }
      }
      expect(worst, lod).toBeGreaterThan(10);
      expect(worst, lod).toBeLessThan(22.5);
    }
  });

  it("holds each state for 250 ms and shows only the latest of faster requests", () => {
    const e = new DotEngine({ seed: 1, t: 0, state: "idle" });
    e.setState("thinking", 100);
    e.setState("acting", 150);
    expect(e.pose(STATE_HOLD_MS - 1).state).toBe("idle");
    expect(e.pose(STATE_HOLD_MS).state).toBe("acting");
    e.setState("listening", STATE_HOLD_MS + 100);
    e.setState("acting", STATE_HOLD_MS + 120);
    expect(e.pose(2 * STATE_HOLD_MS + 50).state).toBe("acting");
    e.setState("idle", 1000);
    expect(e.pose(1000).state).toBe("idle");
  });

  it("blinks with a quick close, a short hold and a slower open", () => {
    const e = new DotEngine({ seed: 5, t: 0, state: "idle", lod: "badge" });
    let start = -1;
    for (let t = 0; t < 10_000 && start < 0; t++) if (e.pose(t).blink > 0) start = t;
    expect(start).toBeGreaterThan(0);
    const at = (dt: number) => e.pose(start + dt).blink;
    expect(at(34)).toBeLessThan(0.3);
    expect(at(69)).toBeGreaterThan(0.8);
    expect(at(85)).toBeCloseTo(0.9, 5);
    expect(at(140)).toBeLessThan(0.4);
    expect(at(140)).toBeGreaterThan(0.05);
    expect(at(242)).toBe(0);
  });

  it("drops breath, drift, microsaccades, hops, squash and shakes under reduced motion", () => {
    const sample = (reducedMotion: boolean, state: "idle" | "waiting" | "error") => {
      const e = new DotEngine({ seed: 3, t: 0, state: "idle", lod: "hero", reducedMotion });
      e.setState(state, 1000);
      const poses: DotPose[] = [];
      for (let t = 2000; t < 14_000; t += 16) poses.push(e.pose(t));
      const spread = (pick: (p: DotPose) => number) => {
        const values = poses.map(pick);
        return Math.max(...values) - Math.min(...values);
      };
      return {
        body: Math.max(
          spread((p) => p.body.x),
          spread((p) => p.body.y),
          spread((p) => p.body.sx),
          spread((p) => p.body.sy),
        ),
        blinks: poses.filter((p) => p.blink > 0).length,
      };
    };
    for (const state of ["idle", "waiting"] as const) {
      expect(sample(false, state).body).toBeGreaterThan(0.05);
      expect(sample(true, state).body).toBeLessThan(1e-6);
      expect(sample(true, state).blinks).toBeGreaterThan(0);
    }
    const shake = (reducedMotion: boolean) => {
      const e = new DotEngine({ seed: 3, t: 0, state: "idle", lod: "hero", reducedMotion });
      e.setState("error", 1000);
      return Math.max(
        ...Array.from({ length: 60 }, (_, i) => Math.abs(e.pose(1000 + i * 8).body.x)),
      );
    };
    expect(shake(false)).toBeGreaterThan(0.5);
    expect(shake(true)).toBe(0);
  });

  it("holds the gaze still between looks under reduced motion", () => {
    const e = new DotEngine({ seed: 9, t: 0, state: "idle", lod: "hero", reducedMotion: true });
    const gazes = new Set<string>();
    for (let t = 1000; t < 12_000; t += 16) {
      const { x, y } = e.pose(t).gaze;
      gazes.add(`${x.toFixed(6)},${y.toFixed(6)}`);
    }
    expect(gazes.size).toBe(1);
  });

  it("halves the talk-bob under reduced motion", () => {
    const peak = (reducedMotion: boolean) => {
      const e = new DotEngine({ seed: 4, t: 0, state: "speaking", reducedMotion });
      let m = 0;
      for (let t = 0; t < 6000; t += 5) m = Math.max(m, e.pose(t).talk);
      return m;
    };
    expect(peak(false)).toBeGreaterThan(0.6);
    expect(peak(true)).toBeLessThanOrEqual(0.5);
    expect(peak(true)).toBeGreaterThan(0.3);
  });

  it("drops the talk-bob at badge size", () => {
    const e = new DotEngine({ seed: 4, t: 0, state: "speaking", lod: "badge" });
    let peak = 0;
    for (let t = 0; t < 6000; t += 5) peak = Math.max(peak, e.pose(t).talk);
    expect(peak).toBe(0);
  });

  it("turns annoyed at a second error within a minute, with or without reduced motion", () => {
    for (const reducedMotion of [false, true]) {
      const e = new DotEngine({ seed: 8, t: 0, state: "idle", reducedMotion });
      e.setState("error", 1000);
      expect(e.pose(3000).state, `reduced ${reducedMotion}`).toBe("error");
      e.setState("idle", 3000);
      e.react("error", 5000);
      expect(e.pose(5899).state, `reduced ${reducedMotion}`).toBe("idle");
      expect(e.pose(5900).state, `reduced ${reducedMotion}`).toBe("annoyed");
    }
  });

  it("celebrates success at most once per 5 s", () => {
    const happyAt = (e: DotEngine, t: number) => e.pose(t).eyes[0].happy;
    const e = new DotEngine({ seed: 5, t: 0, state: "idle" });
    e.react("success", 1000);
    expect(happyAt(e, 1500)).toBeGreaterThan(0.9);
    expect(happyAt(e, 2600)).toBeLessThan(0.05);
    e.react("success", 3000);
    expect(happyAt(e, 3500)).toBeLessThan(0.05);
    e.react("success", 6000);
    expect(happyAt(e, 6500)).toBeGreaterThan(0.9);
  });

  it("wakes from sleep with two quick blinks, then looks at the user", () => {
    const e = new DotEngine({ seed: 6, t: 0, state: "sleeping", lod: "badge" });
    e.setState("idle", 1000);
    expect(e.pose(1040 + 70).blink).toBeGreaterThan(0.85);
    expect(e.pose(1170).blink).toBeLessThan(0.3);
    expect(e.pose(1190 + 70).blink).toBeGreaterThan(0.85);
    const { x, y } = e.pose(1700).gaze;
    expect(Math.hypot(x, y)).toBeLessThan(0.2);
  });

  it("crossfades the xenon rim only while dot has control", () => {
    const e = new DotEngine({ seed: 2, t: 0, state: "acting" });
    expect(e.pose(500).plate.rim).toBe(0);
    e.setControl(true, 500);
    expect(e.pose(2000).plate.rim).toBeCloseTo(1, 3);
    e.setState("idle", 2000);
    expect(e.pose(3000).plate.rim).toBeCloseTo(1, 3);
  });

  it("bobs as it says a line without changing what it is doing", () => {
    const e = new DotEngine({ seed: 3, t: 0, state: "acting" });
    e.say(500, 1200);
    let peak = 0;
    for (let t = 500; t < 1700; t += 5) {
      const pose = e.pose(t);
      expect(pose.state).toBe("acting");
      peak = Math.max(peak, pose.talk);
    }
    expect(peak).toBeGreaterThan(0.5);
    expect(e.pose(3000).talk).toBe(0);
  });

  it("looks at the action point within 120 ms of being told where it is", () => {
    const e = new DotEngine({ seed: 3, t: 0, state: "acting" });
    e.pose(1000);
    e.setFocus({ x: -5, y: -3 }, 1000);
    const { x, y } = e.pose(1120).gaze;
    expect(x).toBeLessThan(-4);
    expect(y).toBeLessThan(-2);
  });

  it("keeps its eyes on a known action point while acting and observing", () => {
    const e = new DotEngine({ seed: 9, t: 0, state: "idle" });
    e.setFocus({ x: 6, y: -4 }, 0);
    e.setState("acting", 300);
    expect(e.pose(800).gaze.x).toBeGreaterThan(5);
    e.setState("observing", 800);
    for (let t = 1200; t < 4000; t += 100) {
      const { x, y } = e.pose(t).gaze;
      expect(Math.abs(x - 6)).toBeLessThan(1.8);
      expect(Math.abs(y + 4)).toBeLessThan(1.4);
    }
  });

  it("dozes with heavy lids but never closes its eyes while the computer is on", () => {
    const e = new DotEngine({ seed: 4, t: 0, state: "idle" });
    e.setState("dozing", 300);
    for (let t = 300; t < 60_000; t += 50) expect(e.pose(t).eyes[0].closed).toBe(0);
    expect(e.pose(60_000).eyes[0].up).toBeGreaterThan(0.5);
  });

  it("keeps blinking while it watches the computer", () => {
    const e = new DotEngine({ seed: 5, t: 0, state: "watching" });
    const blinks: number[] = [];
    let closing = false;
    for (let t = 0; t < 40_000; t += 10) {
      const shut = e.pose(t).blink > 0.5;
      if (shut && !closing) blinks.push(t);
      closing = shut;
    }
    const gaps = blinks.slice(1).map((t, i) => t - (blinks[i] as number));
    expect(blinks.length).toBeGreaterThan(3);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(7000 / 0.8);
  });

  it("leans its resting gaze where the host says the stage is", () => {
    const e = new DotEngine({ seed: 7, t: 0, state: "resting" });
    e.setBias({ x: 4, y: -3 }, 0);
    e.setState("idle", 300);
    expect(e.pose(800).gaze.x).toBeCloseTo(4, 0);
    expect(e.pose(800).gaze.y).toBeCloseTo(-3, 0);
  });

  it("carries on with what it was doing when it lands at another size", () => {
    const landed = new DotEngine({ seed: 9, t: 0, state: "thinking", lod: "hero" });
    const seated = new DotEngine({ seed: 9, t: 0, state: "thinking", lod: "glance" });
    for (let t = 0; t <= 900; t += 1000 / 60) {
      landed.pose(t);
      seated.pose(t);
    }
    landed.setLod("glance", 900);
    for (let t = 900; t <= 4000; t += 250)
      expect(fingerprint(landed.pose(t)), `at ${t}`).toBe(fingerprint(seated.pose(t)));
  });

  it("jumps ahead after a long gap without replaying it", () => {
    const e = new DotEngine({ seed: 6, t: 0, state: "idle" });
    e.setState("thinking", 100);
    e.skipTo(3_600_000);
    const pose = e.pose(3_600_000);
    expect(pose.state).toBe("thinking");
    expect(pose.eyes[0].up).toBeCloseTo(0.1, 6);
  });
});

describe("springVelocity", () => {
  it("is the time derivative of springValue", () => {
    for (const p of [spring(0.35, 0.11), spring(1, 0.28), spring(1.4, 0.3)]) {
      for (const t of [0, 0.03, 0.1, 0.4]) {
        const h = 1e-6;
        const slope = (springValue(2, 0, 5, t + h, p) - springValue(2, 0, 5, t - h, p)) / (2 * h);
        expect(springVelocity(2, 0, 5, t, p)).toBeCloseTo(slope, 3);
      }
    }
  });
});

describe("Channel", () => {
  it("reads as still once its spring has settled beyond any visible motion", () => {
    for (const p of [SPRINGS.pose, SPRINGS.drift, SPRINGS.hop, SPRINGS.shake]) {
      const c = new Channel(0, p);
      expect(c.speed(0)).toBe(0);
      c.set(30, 0);
      expect(c.speed(20)).toBeGreaterThan(1);
      expect(c.speed(settleMs(p) - 1)).toBeLessThan(1e-3);
      expect(c.speed(settleMs(p))).toBe(0);
      c.kick(5, 5000, p);
      expect(c.speed(5010)).toBeGreaterThan(1);
    }
  });
});
