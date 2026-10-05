import type { SynthFrame } from "@localdot/stage/testing";
import type { FeedHandlers, FrameFeed } from "../feed.ts";

// A FrameFeed the test drives: frames go in with an arrival stamp, key requests and stops are counted.
export class FakeFeed implements FrameFeed {
  handlers: FeedHandlers | null = null;
  started = false;
  stopped = false;
  keyRequests: number[] = [];
  #lastArrival = 0;

  attach(h: FeedHandlers): FrameFeed {
    this.handlers = h;
    return this;
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  requestKeyframe(): void {
    this.keyRequests.push(this.#lastArrival);
  }
  frame(f: SynthFrame, arrivalMicros: number, width: number, height: number): void {
    this.#lastArrival = arrivalMicros;
    if (!this.stopped)
      this.handlers?.onFrame({ arrivalMicros, key: f.key, width, height, data: f.data });
  }
}
