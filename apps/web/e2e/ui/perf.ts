import { appendFileSync } from "node:fs";
import { loadavg } from "node:os";
import type { Browser, CDPSession, Page } from "@playwright/test";

// What the page counts from its first script: React commits, through the DevTools hook React calls
// after each one, and how far each reached; animation frames; the mascot's prop drawings; long
// tasks; and the input events the Event Timing API reports (those of 16 ms or more).
export interface PageCounts {
  commits: number;
  // Commits that rendered Theatre, the signed-in page App renders, and the components each commit
  // rendered.
  theatreRenders: number;
  rendered: number;
  // Time spent in the hook itself, which the other numbers include.
  hookMs: number;
  frames: number;
  // Times the mascot drew its props (a caret, a sweep): each drawing clears their front layer first.
  dotDraws: number;
  // Frames that came more than 50 ms after the one before, and the longest gap.
  slowFrames: number;
  longestFrame: number;
  longTasks: number[];
  events: { name: string; duration: number; start: number }[];
}

declare global {
  interface Window {
    __perf?: PageCounts;
  }
}

function probe() {
  if (window !== window.top) return;
  const counts: PageCounts = {
    commits: 0,
    theatreRenders: 0,
    rendered: 0,
    hookMs: 0,
    frames: 0,
    dotDraws: 0,
    slowFrames: 0,
    longestFrame: 0,
    longTasks: [],
    events: [],
  };
  window.__perf = counts;
  interface Fiber {
    tag: number;
    flags: number;
    child: Fiber | null;
    sibling: Fiber | null;
    alternate: Fiber | null;
  }
  // FunctionComponent, ClassComponent, ForwardRef and SimpleMemoComponent run their own code; a
  // fiber that did so in this commit carries PerformedWork (1). A child list the commit left alone
  // is shared with the previous tree, as React DevTools reads it.
  const OWN_CODE = new Set([0, 1, 11, 15]);
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    configurable: true,
    value: {
      isDisabled: false,
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        const started = performance.now();
        counts.commits++;
        // main.tsx renders StrictMode > ErrorBoundary > App, the first function component down,
        // and App renders only Theatre once signed in.
        let app = root.current.child;
        while (app && app.tag !== 0) app = app.child;
        const theatre = app?.child?.tag === 0 ? app.child : null;
        const stack = [root.current];
        for (let fiber = stack.pop(); fiber; fiber = stack.pop()) {
          if (OWN_CODE.has(fiber.tag) && fiber.flags & 1) {
            counts.rendered++;
            if (fiber === theatre) counts.theatreRenders++;
          }
          if (fiber.alternate && fiber.child === fiber.alternate.child) continue;
          for (let child = fiber.child; child; child = child.sibling) stack.push(child);
        }
        counts.hookMs += performance.now() - started;
      },
    },
  });
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (...args) {
    if (this.canvas.classList.contains("dot-props-front")) counts.dotDraws++;
    return clear.apply(this, args);
  };
  let last = 0;
  const frame = (at: number) => {
    if (last) {
      const gap = at - last;
      if (gap > 50) counts.slowFrames++;
      counts.longestFrame = Math.max(counts.longestFrame, gap);
    }
    last = at;
    counts.frames++;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) counts.longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        counts.events.push({ name: entry.name, duration: entry.duration, start: entry.startTime });
    }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
  } catch {}
}

export async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(probe);
}

export async function pageCounts(page: Page): Promise<PageCounts> {
  const counts = await page.evaluate(() => structuredClone(window.__perf));
  if (!counts) throw new Error("The page has no probes");
  return counts;
}

// The renderer's own figures for the page: counts, and seconds of main-thread work (TaskDuration
// and its parts), main-thread CPU (ThreadTime) and the renderer process's CPU (ProcessTime).
export async function rendererMetrics(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

// Seconds of CPU each kind of browser process has used: the GPU process draws the page and the
// stage's WebGL.
export async function processCpu(browser: Browser | null): Promise<Record<string, number>> {
  if (!browser) return {};
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as {
      processInfo: { type: string; cpuTime: number }[];
    };
    const cpu: Record<string, number> = {};
    for (const { type, cpuTime } of processInfo) cpu[type] = (cpu[type] ?? 0) + cpuTime;
    return cpu;
  } finally {
    await cdp.detach();
  }
}

// Requests whose path matches `path`, by when they were sent.
export function countRequests(page: Page, path: RegExp, method = "GET"): () => number[] {
  const seen: number[] = [];
  page.on("request", (request) => {
    if (request.method() === method && path.test(new URL(request.url()).pathname))
      seen.push(Date.now());
  });
  return () => seen;
}

export interface Mark {
  at: number;
  counts: PageCounts;
  renderer: Record<string, number>;
  cpu: Record<string, number>;
}

export async function mark(page: Page, cdp: CDPSession): Promise<Mark> {
  const [counts, renderer, cpu] = await Promise.all([
    pageCounts(page),
    rendererMetrics(cdp),
    processCpu(page.context().browser()),
  ]);
  return { at: Date.now(), counts, renderer, cpu };
}

const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

// What happened between two marks, per second where a rate reads best.
export function between(from: Mark, to: Mark) {
  const seconds = (to.at - from.at) / 1000;
  const counted = (key: keyof PageCounts) =>
    (to.counts[key] as number) - (from.counts[key] as number);
  const metric = (name: string) => grew(from, to, name);
  const longTasks = to.counts.longTasks.slice(from.counts.longTasks.length);
  const commits = counted("commits");
  return {
    seconds: round(seconds),
    commitsPerS: round(commits / seconds),
    theatreRendersPerS: round(counted("theatreRenders") / seconds),
    componentsPerCommit: commits ? Math.round(counted("rendered") / commits) : 0,
    hookMsPerS: round(counted("hookMs") / seconds),
    longTasks: longTasks.length,
    longTaskMs: Math.round(longTasks.reduce((sum, ms) => sum + ms, 0)),
    longestTaskMs: Math.round(Math.max(0, ...longTasks)),
    mainTaskMsPerS: Math.round((metric("TaskDuration") * 1000) / seconds),
    scriptMsPerS: Math.round((metric("ScriptDuration") * 1000) / seconds),
    styleMsPerS: round((metric("RecalcStyleDuration") * 1000) / seconds),
    layoutMsPerS: round((metric("LayoutDuration") * 1000) / seconds),
    recalcsPerS: round(metric("RecalcStyleCount") / seconds),
    layoutsPerS: round(metric("LayoutCount") / seconds),
    mainCpuPct: Math.round((metric("ThreadTime") * 100) / seconds),
    rendererCpuPct: Math.round((metric("ProcessTime") * 100) / seconds),
    gpuCpuPct: Math.round((((to.cpu.GPU ?? 0) - (from.cpu.GPU ?? 0)) * 100) / seconds),
    rafFps: round(counted("frames") / seconds),
    dotDrawsPerS: round(counted("dotDraws") / seconds),
    slowFrames: counted("slowFrames"),
    longestFrameMs: Math.round(to.counts.longestFrame),
  };
}

// How far one of the renderer's metrics grew between two marks.
export const grew = (from: Mark, to: Mark, name: string) =>
  (to.renderer[name] ?? 0) - (from.renderer[name] ?? 0);

// The 75th percentile and the largest of `events` named `name` that started in [from, to), where
// each of `expected` events the API did not report took under 16 ms (counted as 0).
export function eventLatency(
  counts: PageCounts,
  name: string,
  window: { from: number; to: number },
  expected: number,
) {
  const reported = counts.events
    .filter((event) => event.name === name && event.start >= window.from && event.start < window.to)
    .map((event) => event.duration);
  const all = [...reported, ...Array(Math.max(0, expected - reported.length)).fill(0)].sort(
    (a, b) => a - b,
  );
  const p75 = all[Math.ceil(all.length * 0.75) - 1] ?? 0;
  return { over16: reported.length, p75Ms: p75, maxMs: Math.max(0, ...reported) };
}

// Appends one run's numbers to QA_PERF_OUT, a JSON-lines file, when it is set.
export function record(result: Record<string, unknown>) {
  const out = process.env.QA_PERF_OUT;
  if (out)
    appendFileSync(out, `${JSON.stringify({ ...result, load: loadavg().map((n) => round(n)) })}\n`);
}

// The fixture's desktop client, streaming as Selkies' client does: H.264 decoded on the GPU into a
// track generator its <video> plays, `fps` frames a second of a bar moving over the still picture
// (a second of them, encoded once and looped). With `follow` it takes the frame rate the viewer
// asks for, as the daemon sets the capture's; it stops and starts on STOP_VIDEO and START_VIDEO.
function desktopClient(fps: number, follow: boolean) {
  const W = 2560;
  const H = 1600;
  const LOOP = Math.max(30, fps);
  const view = window as unknown as {
    videoChunksReceived: number;
    selkiesTransport: { readyState: number; send(text: string): void; close(): void };
    MediaStreamTrackGenerator: new (init: {
      kind: "video";
    }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };
  };
  let rate = fps;
  let paused = false;
  let n = 0;
  view.videoChunksReceived = 0;
  view.selkiesTransport = {
    readyState: 1,
    send(text) {
      if (text === "STOP_VIDEO") paused = true;
      else if (text === "START_VIDEO") paused = false;
      else if (text === "REQUEST_KEYFRAME") n = Math.ceil(n / LOOP) * LOOP;
      else if (follow && text.startsWith("_ld_q,")) {
        const wish = JSON.parse(text.slice(6)) as { visible: boolean; framerate?: number };
        if (wish.visible && wish.framerate) rate = wish.framerate;
      }
    },
    close() {
      this.readyState = 3;
      paused = true;
    },
  };
  const video = document.getElementById("videoStream") as HTMLVideoElement;
  const track = new view.MediaStreamTrackGenerator({ kind: "video" });
  const writer = track.writable.getWriter();
  video.srcObject = new MediaStream([track]);
  video.play().catch(() => {});
  const still = new Image();
  still.src = "/owned-desktop.webp";
  // A client the stage lets go of while it is still encoding stops quietly, as Selkies' does.
  const ended = (error: unknown) => {
    if (!(error instanceof DOMException)) console.error(error);
  };
  void still
    .decode()
    .then(async () => {
      const canvas = new OffscreenCanvas(W, H);
      const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      const chunks: { type: EncodedVideoChunkType; data: Uint8Array }[] = [];
      const encoder = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          chunks.push({ type: chunk.type, data });
        },
        error: (error) => console.error(error),
      });
      encoder.configure({
        codec: "avc1.640034",
        width: W,
        height: H,
        bitrate: 12e6,
        framerate: fps,
        hardwareAcceleration: "prefer-hardware",
        latencyMode: "realtime",
        avc: { format: "annexb" },
      });
      for (let i = 0; i < LOOP; i++) {
        context.drawImage(still, 0, 0, W, H);
        context.fillStyle = "#3fb5de";
        context.fillRect(Math.round((i * 2400) / LOOP), 240, 160, 1120);
        const frame = new VideoFrame(canvas, { timestamp: (i * 1e6) / fps });
        if (encoder.state === "configured") encoder.encode(frame, { keyFrame: i === 0 });
        frame.close();
      }
      if (encoder.state !== "configured") return;
      await encoder.flush();
      const decoder = new VideoDecoder({
        output: (frame) => void writer.write(frame).catch(() => frame.close()),
        error: (error) => console.error(error),
      });
      decoder.configure({
        codec: "avc1.640034",
        codedWidth: W,
        codedHeight: H,
        hardwareAcceleration: "prefer-hardware",
        optimizeForLatency: true,
      });
      const next = () => {
        if (decoder.state === "closed") return;
        setTimeout(next, 1000 / rate);
        if (paused || decoder.decodeQueueSize > 2) return;
        const chunk = chunks[n % LOOP];
        if (!chunk) return;
        decoder.decode(new EncodedVideoChunk({ ...chunk, timestamp: (n * 1e6) / rate }));
        n++;
        view.videoChunksReceived++;
      };
      next();
    })
    .catch(ended);
}

export async function streamDesktop(page: Page, { fps = 60, follow = true } = {}) {
  await page.route("**/owned-preview.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `(${desktopClient.toString()})(${fps}, ${follow});`,
    }),
  );
}
