export interface Presenter {
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
    } finally {
      frame.close();
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
      show(frame);
    }
  };
  const running = loop().catch(() => {});

  return {
    async stop() {
      await reader.cancel().catch(() => {});
      await running;
    },
  };
}
