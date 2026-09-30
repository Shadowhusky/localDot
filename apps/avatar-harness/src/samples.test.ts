import { describe, expect, it } from "vitest";
import { SAMPLE_SCREEN, SAMPLE_SESSION, sampleTrack } from "./samples.ts";

describe("sampleTrack", () => {
  it("starts where asked, is sorted, and ends at rest", () => {
    const track = sampleTrack(5000);
    const times = track.visemes.map((v) => v.t);
    expect(track.startsAt).toBe(5000);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(track.visemes.at(-1)?.shape).toBe("rest");
  });
});

describe("SAMPLE_SESSION", () => {
  it("is in time order, stays on the sample screen, and ends with the session done", () => {
    const times = SAMPLE_SESSION.map((s) => s.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const { event } of SAMPLE_SESSION) {
      if (event.type === "action.intent" && event.data.point) {
        expect(event.data.point.x).toBeLessThanOrEqual(SAMPLE_SCREEN.w);
        expect(event.data.point.y).toBeLessThanOrEqual(SAMPLE_SCREEN.h);
      }
    }
    expect(SAMPLE_SESSION.at(-1)?.event).toMatchObject({
      type: "session.end",
      data: { reason: "done" },
    });
  });
});
