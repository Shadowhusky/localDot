import { describe, expect, it, vi } from "vitest";
import { type Presenter, type PumpStats, pumpFrames } from "./pump.ts";

const fakeFrame = (w = 2560, h = 1600) =>
  ({ displayWidth: w, displayHeight: h, close: vi.fn() }) as unknown as VideoFrame;

function stream(frames: VideoFrame[]): ReadableStream<VideoFrame> {
  return new ReadableStream<VideoFrame>({
    pull(controller) {
      const next = frames.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
}

describe("pumpFrames", () => {
  it("presents every frame once, closes it, and reports stats at most every reportEveryMs", async () => {
    const frames = [fakeFrame(), fakeFrame(), fakeFrame(1280, 800)];
    const presented: VideoFrame[] = [];
    const presenter: Presenter = { present: (f) => presented.push(f) };
    const reports: PumpStats[] = [];
    let t = 0;
    const pump = pumpFrames(stream([...frames]), presenter, (s) => reports.push(s), {
      now: () => (t += 400),
      reportEveryMs: 500,
    });
    await new Promise((r) => setTimeout(r, 20));
    await pump.stop();
    expect(presented).toEqual(frames);
    for (const f of frames) expect(f.close).toHaveBeenCalledTimes(1);
    expect(reports[0]).toMatchObject({ presented: 1, width: 2560, height: 1600 });
    expect(reports.at(-1)).toMatchObject({ presented: 3, width: 1280, height: 800 });
    expect(reports.length).toBeLessThan(frames.length + 1);
  });

  it("stops reading when stopped", async () => {
    let pulls = 0;
    // Each frame arrives on a later macrotask, as a real track's do: a source that enqueued at once
    // would keep the read loop on microtasks and starve every timer, Vitest's included.
    const endless = new ReadableStream<VideoFrame>({
      async pull(controller) {
        pulls += 1;
        await new Promise((r) => setTimeout(r, 1));
        controller.enqueue(fakeFrame());
      },
    });
    const pump = pumpFrames(endless, { present: () => {} }, () => {});
    await new Promise((r) => setTimeout(r, 20));
    await pump.stop();
    const after = pulls;
    await new Promise((r) => setTimeout(r, 20));
    expect(pulls).toBe(after);
  });

  it("presents and closes the seed frame before the stream's first, and reports it at once", async () => {
    const first = fakeFrame();
    const next = fakeFrame();
    const presented: VideoFrame[] = [];
    const reports: PumpStats[] = [];
    const pump = pumpFrames(
      stream([next]),
      { present: (f) => presented.push(f) },
      (s) => reports.push(s),
      { first },
    );
    await new Promise((r) => setTimeout(r, 20));
    await pump.stop();
    expect(presented).toEqual([first, next]);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(reports[0]).toMatchObject({ presented: 1, width: 2560, height: 1600 });
  });

  it("closes a seed frame it cannot present and pumps the stream anyway", async () => {
    const first = fakeFrame();
    const next = fakeFrame();
    const presented: VideoFrame[] = [];
    const presenter: Presenter = {
      present(f) {
        if (f === first) throw new Error("detached");
        presented.push(f);
      },
    };
    const pump = pumpFrames(stream([next]), presenter, () => {}, { first });
    await new Promise((r) => setTimeout(r, 20));
    await pump.stop();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(presented).toEqual([next]);
    expect(next.close).toHaveBeenCalledTimes(1);
  });
});
