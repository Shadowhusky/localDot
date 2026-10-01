import { canvasPresenter } from "./presenter.ts";
import { type Presenter, type PumpStats, pumpFrames } from "./pump.ts";

export type WorkerIn =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "frames"; readable: ReadableStream<VideoFrame>; first?: VideoFrame }
  | { type: "stop" };

export type WorkerOut = { type: "stats"; stats: PumpStats } | { type: "error"; message: string };

const scope = self as unknown as {
  postMessage(message: WorkerOut): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let presenter: Presenter | undefined;
let pump: { stop(): Promise<void> } | undefined;
// One message at a time, so a pump has stopped before the next one paints the same canvas.
let queue = Promise.resolve();

scope.onmessage = (e) => {
  queue = queue.then(() => handle(e.data));
};

async function handle(m: WorkerIn): Promise<void> {
  try {
    if (m.type === "init") {
      presenter = canvasPresenter(m.canvas);
      return;
    }
    await pump?.stop();
    pump = undefined;
    if (m.type !== "frames") return;
    if (!presenter) {
      m.first?.close();
      await m.readable.cancel();
      throw new Error("frames before init");
    }
    pump = pumpFrames(
      m.readable,
      presenter,
      (stats) => scope.postMessage({ type: "stats", stats }),
      {
        first: m.first,
      },
    );
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
