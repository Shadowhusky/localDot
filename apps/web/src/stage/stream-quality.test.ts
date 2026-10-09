import { describe, expect, it } from "vitest";
import {
  CRFS,
  FRAMERATES,
  framerateCeiling,
  HANDHELD_FRAMERATE,
  PROBE_TICKS,
  QualityController,
  type QualitySample,
  RECOVER_MAX_TICKS,
  RECOVER_TICKS,
  RoundTrips,
} from "./stream-quality.ts";

const BASE = 80;
const clear: QualitySample = {
  rttMs: BASE + 10,
  baseRttMs: BASE,
  decodedFps: 60,
  presentedFps: 60,
};
const queued: QualitySample = { ...clear, rttMs: BASE + 300 };
const flooded: QualitySample = { ...clear, rttMs: BASE + 900 };
const neutral: QualitySample = { ...clear, rttMs: BASE + 100 };
const slowDevice: QualitySample = { ...clear, decodedFps: 60, presentedFps: 30 };

function run(controller: QualityController, sample: QualitySample, ticks: number) {
  const seen = [];
  for (let n = 0; n < ticks; n++) seen.push(controller.tick(sample));
  return seen;
}

describe("QualityController", () => {
  it("starts at full quality, whatever the choice", () => {
    for (const choice of ["auto", "sharp", "smooth"] as const)
      expect(new QualityController(choice).quality).toEqual({ framerate: 60, crf: 25 });
  });

  it("keeps full quality on a clear link and a device that keeps up", () => {
    const controller = new QualityController();
    run(controller, clear, 30);
    run(controller, { ...clear, decodedFps: 0, presentedFps: 0 }, 30);
    expect(controller.quality).toEqual({ framerate: 60, crf: 25 });
  });

  it("gives up only detail on a queued link, one step every few seconds", () => {
    const controller = new QualityController();
    const seen = run(controller, queued, 9).map((q) => `${q.framerate}/${q.crf}`);
    expect(seen).toEqual([
      "60/25",
      "60/28",
      "60/28",
      "60/28",
      "60/31",
      "60/31",
      "60/31",
      "60/34",
      "60/34",
    ]);
    run(controller, queued, 30);
    expect(controller.quality).toEqual({ framerate: 60, crf: CRFS.at(-1) });
  });

  it("drops all the detail at once when the queue is already long", () => {
    const controller = new QualityController();
    expect(controller.tick(flooded)).toEqual({ framerate: 60, crf: CRFS.at(-1) });
  });

  it("spares a slow device frames before detail, once it has lagged for a few seconds", () => {
    const controller = new QualityController();
    run(controller, slowDevice, 3);
    expect(controller.quality).toEqual({ framerate: 60, crf: 25 });
    controller.tick(slowDevice);
    expect(controller.quality).toEqual({ framerate: FRAMERATES[1], crf: 25 });
  });

  it("does not blame the device for frames that arrive in bursts off a queued link", () => {
    const controller = new QualityController();
    run(controller, { ...queued, presentedFps: 20 }, 2);
    expect(controller.quality).toEqual({ framerate: 60, crf: 28 });
  });

  it("judges no device by a still screen", () => {
    const controller = new QualityController();
    run(controller, { ...clear, decodedFps: 4, presentedFps: 0 }, 10);
    expect(controller.quality).toEqual({ framerate: 60, crf: 25 });
  });

  it("recovers one step at a time, the last one taken first, after a clear spell", () => {
    const controller = new QualityController();
    run(controller, slowDevice, 4);
    run(controller, queued, 5);
    expect(controller.quality).toEqual({ framerate: 45, crf: 28 });
    run(controller, clear, RECOVER_TICKS - 1);
    expect(controller.quality).toEqual({ framerate: 45, crf: 28 });
    controller.tick(clear);
    expect(controller.quality).toEqual({ framerate: 45, crf: 25 });
    run(controller, clear, RECOVER_TICKS);
    expect(controller.quality).toEqual({ framerate: 60, crf: 25 });
  });

  it("does not recover while the link sits between clear and queued", () => {
    const controller = new QualityController();
    run(controller, queued, 2);
    run(controller, neutral, 60);
    expect(controller.quality.crf).toBe(28);
  });

  it("waits twice as long after each step up that brought the queue back, up to two minutes", () => {
    const controller = new QualityController();
    const waits = [];
    for (let round = 0; round < 6; round++) {
      run(controller, queued, 2);
      expect(controller.quality.crf).toBe(28);
      waits.push(controller.recoverTicks);
      run(controller, clear, controller.recoverTicks - 1);
      expect(controller.quality.crf).toBe(28);
      controller.tick(clear);
      expect(controller.quality.crf).toBe(25);
    }
    expect(waits).toEqual([8, 16, 32, 64, RECOVER_MAX_TICKS, RECOVER_MAX_TICKS]);
    expect(RECOVER_TICKS).toBe(8);
  });

  it("shortens the wait again once a step up holds", () => {
    const controller = new QualityController();
    run(controller, queued, 2);
    run(controller, clear, RECOVER_TICKS);
    run(controller, queued, 2);
    expect(controller.recoverTicks).toBe(RECOVER_TICKS * 2);
    run(controller, clear, RECOVER_TICKS * 2);
    expect(controller.quality.crf).toBe(25);
    run(controller, clear, PROBE_TICKS);
    expect(controller.recoverTicks).toBe(RECOVER_TICKS);
  });

  it("gives back the frames a slow device took once it keeps up, with no round trip measured", () => {
    const controller = new QualityController();
    const unmeasured = { ...clear, rttMs: null, baseRttMs: null };
    run(controller, { ...slowDevice, rttMs: null, baseRttMs: null }, 4);
    expect(controller.quality.framerate).toBe(45);
    run(controller, unmeasured, RECOVER_TICKS);
    expect(controller.quality).toEqual({ framerate: 60, crf: 25 });
  });

  it("gives back a slow device's frames on a jittery link, but keeps the link's detail", () => {
    const controller = new QualityController();
    run(controller, slowDevice, 4);
    run(controller, queued, 5);
    expect(controller.quality).toEqual({ framerate: 45, crf: 28 });
    run(controller, neutral, RECOVER_TICKS);
    expect(controller.quality).toEqual({ framerate: 60, crf: 28 });
    run(controller, neutral, 60);
    expect(controller.quality.crf).toBe(28);
  });

  it("does not count a still screen toward a device's recovery", () => {
    const controller = new QualityController();
    run(controller, slowDevice, 4);
    run(controller, { ...clear, rttMs: null, decodedFps: 2, presentedFps: 2 }, 60);
    expect(controller.quality.framerate).toBe(45);
  });

  it("gives frames before detail when the choice is Sharp", () => {
    const controller = new QualityController("sharp");
    run(controller, queued, 2);
    expect(controller.quality).toEqual({ framerate: 45, crf: 25 });
    run(controller, queued, 12);
    expect(controller.quality).toEqual({ framerate: 12, crf: 25 });
    run(controller, queued, 3);
    expect(controller.quality).toEqual({ framerate: 12, crf: 28 });
    expect(new QualityController("sharp").tick(flooded)).toEqual({ framerate: 12, crf: 25 });
  });

  it("gives detail before frames when the choice is Smooth, even for a slow device", () => {
    const controller = new QualityController("smooth");
    run(controller, slowDevice, 4);
    expect(controller.quality).toEqual({ framerate: 60, crf: 28 });
    run(controller, queued, 12);
    expect(controller.quality).toEqual({ framerate: 60, crf: CRFS.at(-1) });
    run(controller, queued, 3);
    expect(controller.quality).toEqual({ framerate: 45, crf: CRFS.at(-1) });
  });

  it("starts again from full quality when the choice changes", () => {
    const controller = new QualityController();
    run(controller, queued, 4);
    expect(controller.quality.crf).toBeGreaterThan(25);
    controller.prefer("auto");
    expect(controller.quality.crf).toBeGreaterThan(25);
    controller.prefer("sharp");
    expect(controller.quality).toEqual({ framerate: 60, crf: 25 });
    run(controller, queued, 2);
    expect(controller.quality).toEqual({ framerate: 45, crf: 25 });
  });

  it("judges nothing by the link before a ping has come back", () => {
    const controller = new QualityController();
    run(controller, { ...clear, rttMs: null, baseRttMs: null }, 30);
    expect(controller.quality).toEqual({ framerate: 60, crf: 25 });
  });
});

describe("a handheld viewer", () => {
  it("is a touch device, which asks for 30 fps at most", () => {
    expect(framerateCeiling((query) => query === "(pointer: coarse)")).toBe(HANDHELD_FRAMERATE);
    expect(framerateCeiling(() => false)).toBe(60);
  });

  it("starts at its ceiling, steps down from it for a slow device and never recovers past it", () => {
    const controller = new QualityController("auto", HANDHELD_FRAMERATE);
    expect(controller.quality).toEqual({ framerate: 30, crf: 25 });
    run(controller, { ...slowDevice, decodedFps: 30, presentedFps: 15 }, 4);
    expect(controller.quality.framerate).toBe(24);
    run(
      controller,
      { ...clear, decodedFps: 24, presentedFps: 24 },
      RECOVER_TICKS + PROBE_TICKS + 40,
    );
    expect(controller.quality.framerate).toBe(30);
    controller.prefer("smooth");
    expect(controller.quality.framerate).toBe(30);
  });
});

describe("RoundTrips", () => {
  it("smooths the pings and keeps the lowest of the recent ones as the empty link", () => {
    const trips = new RoundTrips();
    expect(trips.smoothed).toBeNull();
    expect(trips.base).toBeNull();
    trips.add(100);
    trips.add(300);
    expect(trips.smoothed).toBe(180);
    expect(trips.base).toBe(100);
    for (let n = 0; n < RoundTrips.WINDOW; n++) trips.add(200);
    expect(trips.base).toBe(200);
  });

  it("does not take one lucky ping for the empty link", () => {
    const trips = new RoundTrips();
    trips.add(40);
    for (let n = 1; n < RoundTrips.WINDOW; n++) trips.add(140 + (n % 10) * 10);
    expect(trips.base).toBe(150);
  });
});
