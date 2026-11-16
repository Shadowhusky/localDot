import { PerformanceObserver } from "node:perf_hooks";

export interface BusyWatchOptions {
  everyMs?: number;
  afterMs?: number;
  gcMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

// Says in the log when the daemon could answer nothing for a while, and when collecting garbage
// held it: every page's requests wait out such a pause, which reads as a slow connection.
export function watchBusy({
  everyMs = 500,
  afterMs = 2_000,
  gcMs = 500,
  log = (line) => console.error(line),
  now = () => performance.now(),
}: BusyWatchOptions = {}): () => void {
  let last = now();
  const timer = setInterval(() => {
    const at = now();
    const late = at - last - everyMs;
    last = at;
    if (late >= afterMs)
      log(`the daemon was busy for ${(late / 1000).toFixed(1)} s and answered nothing meanwhile`);
  }, everyMs);
  timer.unref();
  const gc = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      if (entry.duration >= gcMs)
        log(`collecting garbage held the daemon for ${Math.round(entry.duration)} ms`);
  });
  gc.observe({ entryTypes: ["gc"] });
  return () => {
    clearInterval(timer);
    gc.disconnect();
  };
}
