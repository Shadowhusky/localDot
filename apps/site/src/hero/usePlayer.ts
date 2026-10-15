import { useCallback, useEffect, useRef, useState } from "react";
import { type DemoTimeline, toSession, toVideo } from "./demo.ts";
import { DemoFeed } from "./feed.ts";

// Ready: no demo yet. Starting: its request is in the chat and dot listens while the recording
// loads. Playing and paused: the task's recording runs. Done: the task has ended and its result is
// in the chat.
export type Phase = "ready" | "starting" | "playing" | "paused" | "done";

export interface Player {
  demo: DemoTimeline | null;
  feed: DemoFeed | null;
  phase: Phase;
  // Where the task is, in ms from its start.
  sessionMs: number;
  // Where the recording is going while it travels to a moment, or null.
  travelling: "ahead" | "back" | null;
  video(element: HTMLVideoElement | null): void;
  // Starts a task: from its request, or straight at a moment of its recording (ms), playing or still.
  start(demo: DemoTimeline, at?: { videoMs: number; still: boolean }): void;
  toggle(): void;
  // Rests the recording without pausing the task, as while the visitor has the computer.
  hold(on: boolean): void;
  // Winds the recording back from where it was (1) towards its start (0), or lets it go on (null).
  rewind(share: number | null): void;
  // Plays the task again from a moment of it, in ms from its start, as Replay opens at one.
  replayFrom(sessionMs: number): void;
  // Takes the recording to a moment of it (ms) the way a person would: speeding through what lies
  // ahead, winding back through what has passed; then it plays on.
  travel(videoMs: number): void;
}

const LISTEN_MS = 500;
// Browsers play a video at up to 16 times its speed.
export const MAX_RATE = 16;

// How fast to play the recording while travelling to a moment `remaining` seconds of it ahead,
// `elapsed` seconds into the trip: gathering speed from its own, then easing off to land on it.
export function travelRate(remaining: number, elapsed: number): number {
  return Math.min(MAX_RATE, 1 + Math.max(0, elapsed) * 40, Math.max(1, remaining * 4));
}
// The chat and band redraw at most this often while the recording runs; the clock every second.
const DRAW_MS = 120;

export function usePlayer(): Player {
  const [demo, setDemo] = useState<DemoTimeline | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const phaseRef = useRef<Phase>("ready");
  phaseRef.current = phase;
  const [, setDrawn] = useState(0);
  const feed = useRef<DemoFeed | null>(null);
  const element = useRef<HTMLVideoElement | null>(null);
  const sessionMs = useRef(0);
  const run = useRef(0);
  const holding = useRef(false);
  // Where the task ended, so its last words are in once the recording is over.
  const endMs = useRef(0);
  const [travelling, setTravelling] = useState<"ahead" | "back" | null>(null);
  // A start at a moment, applied once the new recording's source is in.
  const cue = useRef<{ id: number; videoMs: number; still: boolean } | null>(null);
  const trip = useRef(0);
  // Winding back pauses the recording without pausing the task.
  const winding = useRef(false);

  const draw = useCallback(() => setDrawn((n) => n + 1), []);

  const settle = useCallback(
    (ms: number) => {
      sessionMs.current = ms;
      feed.current?.advance(ms);
      draw();
    },
    [draw],
  );

  const play = useCallback(() => {
    const video = element.current;
    if (!video || holding.current) return;
    video.play().catch(() => setPhase("paused"));
  }, []);

  const rewound = useRef<number | null>(null);
  const rewind = useCallback(
    (share: number | null) => {
      const video = element.current;
      const current = demo;
      if (!video || !current || !Number.isFinite(video.duration)) return;
      if (share === null) {
        if (rewound.current === null) return;
        rewound.current = null;
        return;
      }
      if (rewound.current === null) rewound.current = video.currentTime;
      const at = Math.max(0, rewound.current * share);
      if (Math.abs(video.currentTime - at) > 0.04) video.currentTime = at;
      settle(toSession(at * 1000, current.segments));
    },
    [demo, settle],
  );

  const replayFrom = useCallback(
    (ms: number) => {
      const video = element.current;
      if (!video || !demo) return;
      // A moment that was cut plays from the next part that was kept.
      const kept = toVideo(ms, demo.segments) ?? demo.segments.find((s) => s.from >= ms)?.at ?? 0;
      video.currentTime = kept / 1000;
      settle(toSession(kept, demo.segments));
      setPhase("playing");
      play();
    },
    [demo, play, settle],
  );

  const hold = useCallback(
    (on: boolean) => {
      if (holding.current === on) return;
      holding.current = on;
      const video = element.current;
      if (!video) return;
      if (on) video.pause();
      else if (phaseRef.current === "playing") play();
    },
    [play],
  );

  const start = useCallback(
    (next: DemoTimeline, at?: { videoMs: number; still: boolean }) => {
      const id = ++run.current;
      cancelAnimationFrame(trip.current);
      setTravelling(null);
      feed.current = new DemoFeed(next.events);
      endMs.current = next.realMs + 1000;
      setDemo(next);
      settle(toSession(at?.videoMs ?? 0, next.segments));
      if (at) {
        cue.current = { id, ...at };
        setPhase(at.still ? "paused" : "playing");
        return;
      }
      setPhase("starting");
      // The new recording's source is in by then.
      window.setTimeout(() => {
        if (run.current !== id) return;
        setPhase("playing");
        const video = element.current;
        if (video) video.currentTime = 0;
        play();
      }, LISTEN_MS);
    },
    [play, settle],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new demo is what brings its source in
  useEffect(() => {
    const pending = cue.current;
    const video = element.current;
    if (!pending || !video || pending.id !== run.current) return;
    cue.current = null;
    video.playbackRate = 1;
    video.currentTime = pending.videoMs / 1000;
    if (!pending.still) play();
  }, [demo, play]);

  const travel = useCallback(
    (videoMs: number) => {
      const video = element.current;
      const current = demo;
      if (!video || !current) return;
      cancelAnimationFrame(trip.current);
      // A start still waiting to roll the recording from its beginning gives way to the trip.
      run.current++;
      const target = videoMs / 1000;
      const from = video.currentTime;
      const arrive = () => {
        video.playbackRate = 1;
        winding.current = false;
        setTravelling(null);
        settle(toSession(video.currentTime * 1000, current.segments));
        setPhase("playing");
        play();
      };
      // With reduced motion the recording waits there, still; held, it plays from there once the
      // hold ends, a start it cut short included.
      if (matchMedia("(prefers-reduced-motion: reduce)").matches || holding.current) {
        video.currentTime = target;
        settle(toSession(videoMs, current.segments));
        if (!holding.current) {
          video.pause();
          setPhase("paused");
        } else if (phaseRef.current === "starting" || phaseRef.current === "done")
          setPhase("playing");
        return;
      }
      const began = performance.now();
      if (target > from) {
        setTravelling("ahead");
        setPhase("playing");
        play();
        const ahead = (now: number) => {
          const left = target - video.currentTime;
          if (left <= 0.04 || holding.current) {
            if (left > 0.04) video.currentTime = target;
            arrive();
            return;
          }
          video.playbackRate = travelRate(left, (now - began) / 1000);
          trip.current = requestAnimationFrame(ahead);
        };
        trip.current = requestAnimationFrame(ahead);
        return;
      }
      setTravelling("back");
      winding.current = true;
      video.pause();
      const seconds = Math.min(1.1, Math.max(0.5, (from - target) * 0.05));
      const back = (now: number) => {
        const k = Math.min(1, (now - began) / 1000 / seconds);
        const at = from + (target - from) * (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);
        if (!video.seeking) video.currentTime = at;
        settle(toSession(at * 1000, current.segments));
        if (k < 1 && !holding.current) {
          trip.current = requestAnimationFrame(back);
          return;
        }
        video.currentTime = target;
        if (holding.current) {
          winding.current = false;
          setTravelling(null);
          return;
        }
        arrive();
      };
      trip.current = requestAnimationFrame(back);
    },
    [demo, play, settle],
  );

  const toggle = useCallback(() => {
    const video = element.current;
    if (!video || !demo) return;
    if (phase === "done") {
      start(demo);
      return;
    }
    if (video.paused) play();
    else video.pause();
  }, [demo, phase, play, start]);

  // The recording's clock drives the task's: each frame maps video time through the cuts.
  useEffect(() => {
    if (phase !== "playing" || !demo) return;
    let frame = 0;
    let last = 0;
    let second = -1;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const video = element.current;
      if (!video) return;
      const ms = toSession(video.currentTime * 1000, demo.segments);
      const before = feed.current?.version;
      sessionMs.current = ms;
      feed.current?.advance(ms);
      const changed = feed.current?.version !== before;
      const tick = Math.floor(ms / 1000);
      if ((changed && now - last > DRAW_MS) || tick !== second) {
        last = now;
        second = tick;
        draw();
      }
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [demo, draw, phase]);

  const video = useCallback(
    (next: HTMLVideoElement | null) => {
      element.current = next;
      if (!next) return;
      next.onplay = () => setPhase((p) => (p === "starting" ? p : "playing"));
      next.onpause = () => {
        if (!holding.current && !winding.current) setPhase((p) => (p === "playing" ? "paused" : p));
      };
      next.onended = () => {
        if (!feed.current) return;
        setPhase("done");
        settle(endMs.current);
      };
    },
    [settle],
  );

  return {
    demo,
    feed: feed.current,
    phase,
    sessionMs: sessionMs.current,
    travelling,
    video,
    start,
    toggle,
    hold,
    rewind,
    replayFrom,
    travel,
  };
}
