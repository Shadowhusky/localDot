import { ulid } from "@localdot/protocol";
import { emptyModel, type Scene } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import { frameLook, pickFrames } from "./export-frames.ts";
import { planExport } from "./export-plan.ts";

function plan(speed: number, fps: 15 | 60) {
  const model = emptyModel();
  model.startT = 0;
  model.ended = { t: 10_000, reason: "done" };
  return planExport(
    {
      sessionId: ulid(),
      fromMs: 0,
      toMs: 10_000,
      speed,
      skipIdle: false,
      captions: false,
      overlays: true,
      size: { w: 1280, h: 800 },
      fps,
      quality: "low",
      format: "mp4",
    },
    model,
    [],
    [{ from: 4_000_000, to: 6_000_000, reason: "user-control" }],
  );
}

describe("the frames an export reads from the recording", () => {
  it("are only those that show the video, at the session times the output samples", () => {
    const picks = pickFrames(plan(3, 15), { firstMs: 1000, lastMs: 10_000 }, []);
    expect(picks.times.length).toBe(50);
    // Before the first picture, screenshots; while you had control, the last picture holds.
    expect(picks.sources.slice(0, 6)).toEqual([
      ...Array.from({ length: 5 }, () => "backdrop"),
      "video",
    ]);
    expect(picks.sources.filter((source) => source === "hold")).toHaveLength(10);
    expect(picks.videoTimes).toHaveLength(35);
    expect(picks.videoTimes[0]).toBe(1000);
    // 3× at 15 fps reads one moment every 200 ms: nothing between them is asked for.
    for (let index = 1; index < picks.videoTimes.length; index++) {
      const step = (picks.videoTimes[index] ?? 0) - (picks.videoTimes[index - 1] ?? 0);
      expect([200, 2200].some((expected) => Math.abs(step - expected) < 1e-6)).toBe(true);
    }
  });

  it("read nothing from a recording without video", () => {
    const picks = pickFrames(plan(1, 60), null, []);
    expect(picks.videoTimes).toEqual([]);
    expect(new Set(picks.sources)).toEqual(new Set(["backdrop", "hold"]));
  });
});

describe("a frame's look", () => {
  const scene = (x: number, elapsedMs: number) =>
    ({
      control: true,
      cursor: { x, y: 10, visible: true },
      hud: { label: "", state: "working", control: true, elapsedMs },
    }) as unknown as Scene;

  it("is the same while nothing on the picture changes, whatever the clock says", () => {
    expect(frameLook("video 1", scene(5, 100), null)).toBe(
      frameLook("video 1", scene(5, 900), null),
    );
  });

  it("changes with the picture, the pointer or the caption", () => {
    const base = frameLook("video 1", scene(5, 100), "Open the report");
    expect(frameLook("video 2", scene(5, 100), "Open the report")).not.toBe(base);
    expect(frameLook("video 1", scene(6, 100), "Open the report")).not.toBe(base);
    expect(frameLook("video 1", scene(5, 100), "Save the file")).not.toBe(base);
    expect(frameLook("video 1", null, "Open the report")).not.toBe(base);
  });
});
