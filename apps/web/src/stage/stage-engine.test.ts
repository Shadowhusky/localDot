// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { APPEARANCE_EVENT } from "../onboarding/appearance.ts";
import { FakeWorker, fakeChromium } from "../testing/fake-chromium.ts";
import type { FrameSource } from "./frame-source.ts";
import { holdEngine } from "./stage-engine.ts";

// A kept stage outlives its page in tests and on a remount; one that is away read the theme from
// whatever the document held then, and threw where it held no tokens.
it("reads the appearance of a kept stage when it is placed again, not while it is away", () => {
  const restore = fakeChromium();
  const key = {};
  const anchor = document.createElement("template");
  document.body.append(anchor);
  try {
    const held = holdEngine(key);
    held.engine.place(anchor);
    const worker = FakeWorker.instances.at(-1);
    const themes = () => worker?.sent.filter(({ message }) => message.type === "theme").length;
    held.engine.unplace(anchor);
    held.release();
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
    expect(themes()).toBe(0);
    const again = holdEngine(key);
    again.engine.place(anchor);
    expect(themes()).toBe(1);
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
    expect(themes()).toBe(2);
    again.engine.close();
  } finally {
    anchor.remove();
    restore();
  }
});

describe("the frames of a tap that carries a track", () => {
  function setup() {
    const restore = fakeChromium();
    const anchor = document.createElement("template");
    document.body.append(anchor);
    const held = holdEngine(null);
    held.engine.place(anchor);
    const worker = FakeWorker.instances.at(-1);
    if (!worker) throw new Error("no worker");
    const caps = (tracks: boolean) => worker.onmessage?.({ data: { type: "caps", tracks } });
    const stopped: string[] = [];
    const track = { id: "clone", stop: () => stopped.push("clone") } as unknown as MediaStreamTrack;
    const frames = vi.fn();
    const source: FrameSource = {
      trackId: "t1",
      track,
      frames,
      stop: () => {
        source.track?.stop();
        stopped.push("source");
      },
    };
    const sent = () => worker.sent.filter(({ message }) => message.type === "frames");
    const done = () => {
      held.engine.close();
      anchor.remove();
      restore();
    };
    return { engine: held.engine, worker, caps, track, frames, source, sent, stopped, done };
  }

  it("hands the track to a worker that reads tracks, and never copies frames on the page", () => {
    const { engine, caps, track, frames, source, sent, stopped, done } = setup();
    try {
      caps(true);
      engine.attach(source);
      expect(sent()).toEqual([
        { message: { type: "frames", sourceId: 1, track }, transfer: [track] },
      ]);
      expect(frames).not.toHaveBeenCalled();
      expect(engine.canvas.dataset.path).toBe("track");
      engine.detach();
      expect(stopped).toEqual(["source"]);
    } finally {
      done();
    }
  });

  it("waits for the worker to say whether it reads tracks", () => {
    const { engine, caps, track, source, sent, done } = setup();
    try {
      engine.attach(source);
      expect(sent()).toEqual([]);
      caps(true);
      expect(sent().map(({ message }) => message.track)).toEqual([track]);
    } finally {
      done();
    }
  });

  it("copies the video's frames for a worker that cannot read tracks, and ends the clone", () => {
    const { engine, caps, frames, source, sent, stopped, done } = setup();
    try {
      caps(false);
      engine.attach(source);
      expect(sent().map(({ message }) => message)).toEqual([
        { type: "frames", sourceId: 1, pushed: true, first: undefined },
      ]);
      expect(frames).toHaveBeenCalledTimes(1);
      expect(stopped).toEqual(["clone"]);
      expect(engine.canvas.dataset.path).toBe("presented");
    } finally {
      done();
    }
  });

  it("copies the video's frames where a track cannot be handed to a worker", () => {
    const { engine, worker, caps, frames, source, sent, done } = setup();
    try {
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer = []) => {
        if ("track" in message) throw new DOMException("not transferable", "DataCloneError");
        post(message, transfer);
      };
      caps(true);
      engine.attach(source);
      expect(sent().map(({ message }) => message.pushed)).toEqual([true]);
      expect(frames).toHaveBeenCalledTimes(1);
      expect(engine.canvas.dataset.path).toBe("presented");
    } finally {
      done();
    }
  });
});
