export interface Presenter {
  // Owns the frame and closes it once drawn or dropped; the pump closes it only on a throw.
  present(frame: VideoFrame): void;
}

export interface PumpStats {
  presented: number;
  fps: number;
  lastFrameAt: number;
  width: number;
  height: number;
}

export interface PumpOptions {
  now?: () => number;
  reportEveryMs?: number;
  // The frame on screen when the track was tapped: the tap sees only later frames, and a still
  // screen sends none, so without it the stage stays empty until something moves.
  first?: VideoFrame;
  // A frame the presenter could not paint ends the pump: the reader is cancelled and the error is
  // handed here, so a lost canvas is reported instead of leaving the stage silently frozen.
  onError?: (err: unknown) => void;
}

// One frame in, one upload out: the loop presents each decoded frame as it arrives and never
// re-uploads on a display tick (A20).
export function pumpFrames(
  readable: ReadableStream<VideoFrame>,
  presenter: Presenter,
  report: (stats: PumpStats) => void,
  opts: PumpOptions = {},
): { stop(): Promise<void> } {
  const now = opts.now ?? (() => performance.now());
  const reportEveryMs = opts.reportEveryMs ?? 500;
  const reader = readable.getReader();
  let presented = 0;
  let windowStart = now();
  let windowFrames = 0;
  let fps = 0;
  let lastReportAt = Number.NEGATIVE_INFINITY;

  const show = (frame: VideoFrame) => {
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    try {
      presenter.present(frame);
    } catch (err) {
      frame.close();
      throw err;
    }
    presented += 1;
    windowFrames += 1;
    const t = now();
    if (t - windowStart >= 1000) {
      fps = Math.round((windowFrames * 1000) / (t - windowStart));
      windowFrames = 0;
      windowStart = t;
    }
    if (presented === 1 || t - lastReportAt >= reportEveryMs) {
      lastReportAt = t;
      report({ presented, fps, lastFrameAt: t, width, height });
    }
  };

  const loop = async () => {
    if (opts.first) {
      try {
        show(opts.first);
      } catch {
        // The track's own frames follow.
      }
    }
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) return;
      if (stopping) {
        frame.close();
        return;
      }
      show(frame);
    }
  };
  let stopping = false;
  const running = loop().catch(async (err: unknown) => {
    if (stopping) return;
    void reader.cancel(err).catch(() => {});
    opts.onError?.(err);
  });

  return {
    async stop() {
      stopping = true;
      // Cancellation closes our pending reads immediately. Its upstream acknowledgement can
      // wait forever on a browser-suspended transferred stream, so it cannot block a fresh tap.
      void reader.cancel().catch(() => {});
      await running;
    },
  };
}
