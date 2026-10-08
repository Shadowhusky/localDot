import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EventDraft,
  emptyManifest,
  RECORDING_DIR,
  type RecordingManifest,
  ulid,
} from "@localdot/protocol";
import { SYNTH_CODEC, type SynthOptions, synthFrame } from "@localdot/stage/testing";
import sharp from "sharp";
import { EventLog } from "../../event-log.ts";
import { FrameStore } from "../../gateway/frames.ts";
import { ControlGate } from "../control-gate.ts";
import { writeManifest } from "../manifest.ts";
import { RecordingWriter } from "../writer.ts";
export interface SeedOptions {
  home: string;
  minutes: number;
  stepsPerMinute?: number;
  title?: string;
  marker?: string;
  takeover?: { fromMs: number; toMs: number };
  video?: boolean;
  synth?: SynthOptions;
}
export interface SeedResult {
  sessionId: string;
  synth: SynthOptions;
  frames: { tMicros: number; index: number }[];
  steps: {
    id: string;
    startMs: number;
    endMs: number;
    dispatchMs: number;
    point: { x: number; y: number };
  }[];
}
type Scheduled =
  | { t: number; event: EventDraft }
  | { t: number; frame: { key: boolean }; index: number }
  | { t: number; idle: true };
export async function seedSession(o: SeedOptions): Promise<SeedResult> {
  if (!Number.isFinite(o.minutes) || o.minutes <= 0 || o.minutes > 1440)
    throw new RangeError("invalid seed duration");
  const stepsPerMinute = o.stepsPerMinute ?? 12;
  if (!Number.isInteger(stepsPerMinute) || stepsPerMinute < 1 || stepsPerMinute > 120)
    throw new RangeError("invalid seed step frequency");
  if (o.marker !== undefined && (!o.marker.length || o.marker.length > 100))
    throw new RangeError("invalid seed marker");
  const durationMs = Math.round(o.minutes * 60000),
    synth = o.synth ?? { widthMbs: 20, heightMbs: 12, keyEvery: 24 };
  if (
    o.takeover &&
    (!Number.isSafeInteger(o.takeover.fromMs) ||
      !Number.isSafeInteger(o.takeover.toMs) ||
      o.takeover.fromMs < 0 ||
      o.takeover.toMs < o.takeover.fromMs ||
      o.takeover.toMs > durationMs)
  )
    throw new RangeError("invalid seed takeover");
  synthFrame(synth, 0);
  const title = (
    o.marker ? `${o.marker} ${o.title ?? "Seeded session"}` : (o.title ?? "Seeded session")
  ).slice(0, 200);
  let now = 0;
  mkdirSync(o.home, { recursive: true, mode: 0o700 });
  const log = new EventLog(o.home, { nowMicros: () => now });
  const id = log.createSession(title),
    dir = join(o.home, "sessions", id, RECORDING_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = new FrameStore(o.home),
    gate = new ControlGate();
  const result: SeedResult = { sessionId: id, synth, frames: [], steps: [] };
  const scheduled: Scheduled[] = [];
  const event = (ms: number, draft: EventDraft) =>
    scheduled.push({ t: Math.round(ms * 1000), event: draft });
  event(0, {
    type: "session.start",
    agent: "main",
    data: { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title },
  });
  if (o.takeover) {
    event(o.takeover.fromMs, {
      type: "control.change",
      agent: "main",
      data: { holder: "user", reason: "user_takeover" },
    });
    event(o.takeover.toMs, {
      type: "control.change",
      agent: "main",
      data: { holder: "agent", reason: "resume" },
    });
  }
  const n = Math.max(1, Math.floor(o.minutes * stepsPerMinute)),
    interval = durationMs / n;
  let index = 0;
  const activity: RecordingManifest["activity"] = [];
  const writer =
    o.video === false
      ? undefined
      : new RecordingWriter({
          dir,
          codec: SYNTH_CODEC,
          width: synth.widthMbs * 16,
          height: synth.heightMbs * 16,
        });
  try {
    if (writer) {
      writeManifest(dir, {
        ...emptyManifest("recording"),
        codec: SYNTH_CODEC,
        width: synth.widthMbs * 16,
        height: synth.heightMbs * 16,
      });
      await writer.start();
    }
    for (let i = 0; i < n; i++) {
      const startMs = Math.round(i * interval),
        dispatchMs = Math.round(startMs + Math.min(500, interval / 8));
      const endMs = Math.round(Math.min(durationMs - 1, startMs + Math.min(2500, interval * 0.8)));
      const step = `seed-${i + 1}`,
        point = { x: 120 + ((i * 173) % 1000), y: 100 + ((i * 97) % 600) },
        typed = Boolean(o.marker && i === 0) || i % 3 === 1,
        cancelled = (i + 1) % 10 === 0;
      result.steps.push({ id: step, startMs, endMs, dispatchMs, point });
      event(startMs, { type: "step.start", agent: "main", step, data: { kind: "gui" } });
      event(Math.min(dispatchMs, startMs + 100), {
        type: "action.intent",
        agent: "main",
        step,
        data: {
          verb: typed ? "type" : "click",
          label: typed ? "Type a sample" : "Open a sample",
          risk: "none",
          point,
          pointer: {
            from: { x: 40, y: 40 },
            to: point,
            startsAt: startMs * 1000,
            durationMs: Math.max(0, dispatchMs - startMs),
            seed: i,
            curve: "minjerk-bow-v1",
          },
        },
      });
      event(Math.min(dispatchMs, startMs + 150), {
        type: "action.target",
        agent: "main",
        step,
        data: {
          target: {
            point,
            source: "coords",
            role: typed ? "textbox" : "button",
            name: "Sample",
            bbox: { x: point.x - 30, y: point.y - 15, w: 60, h: 30 },
          },
        },
      });
      if (cancelled)
        event(dispatchMs, { type: "action.cancel", agent: "main", step, data: { reason: "user" } });
      else
        event(dispatchMs, {
          type: "action.dispatch",
          agent: "main",
          step,
          data: {
            input: typed
              ? { kind: "type", chars: (o.marker ?? "sample").length, masked: (i + 1) % 5 === 0 }
              : { kind: "click", at: point, button: "left", count: 1 },
            pressT: dispatchMs * 1000,
            ringAt: dispatchMs * 1000 + 16000,
            injector: "xtest",
          },
        });
      if (typed && !cancelled) {
        const masked = (i + 1) % 5 === 0;
        event(Math.min(endMs, dispatchMs + 80), {
          type: "text.progress",
          agent: "main",
          step,
          data: {
            count: (o.marker ?? "sample").length,
            masked,
            ...(masked ? {} : { chunk: o.marker ?? "sample" }),
          },
        });
      }
      const frameId = ulid();
      store.save(
        id,
        frameId,
        await sharp({
          create: {
            width: 1280,
            height: 800,
            channels: 3,
            background: { r: (i * 47) % 220, g: 80 + ((i * 13) % 150), b: 90 + ((i * 31) % 130) },
          },
        })
          .webp()
          .toBuffer(),
      );
      event(endMs - 2, {
        type: "screen.settle",
        agent: "main",
        step,
        data: {
          frameT: (endMs - 2) * 1000,
          changed: [{ x: point.x - 20, y: point.y - 10, w: 40, h: 20 }],
          noVisibleChange: cancelled,
        },
      });
      event(endMs - 1, {
        type: "observe",
        agent: "main",
        step,
        data: { frameId, width: 1280, height: 800 },
      });
      event(endMs, { type: "action.result", agent: "main", step, data: { ok: !cancelled } });
      event(endMs, {
        type: "step.end",
        agent: "main",
        step,
        data: { status: cancelled ? "cancelled" : "ok" },
      });
      if (writer) {
        index = Math.ceil(index / synth.keyEvery) * synth.keyEvery;
        let afterTakeover = false;
        let last = dispatchMs * 1000;
        for (let j = 0; j < 24; j++) {
          const t = dispatchMs * 1000 + j * 16667;
          if (t >= durationMs * 1000) break;
          if (o.takeover && t >= o.takeover.fromMs * 1000 && t < o.takeover.toMs * 1000) {
            afterTakeover = true;
            continue;
          }
          if (afterTakeover) {
            index = Math.ceil(index / synth.keyEvery) * synth.keyEvery;
            afterTakeover = false;
          }
          const frameIndex = index++;
          const key = frameIndex % synth.keyEvery === 0;
          scheduled.push({ t, frame: { key }, index: frameIndex });
          last = t;
        }
        scheduled.push({ t: Math.min(durationMs * 1000, last + 16667), idle: true });
      }
    }
    event(durationMs, { type: "session.end", agent: "main", data: { reason: "done" } });
    scheduled.sort((a, b) => a.t - b.t || Number("event" in b) - Number("event" in a));
    for (const item of scheduled) {
      now = item.t;
      if ("event" in item) gate.observe(log.append(id, item.event));
      else if ("idle" in item) {
        if (writer && result.frames.length) await writer.flushIdle(item.t);
      } else if (writer && gate.admit(item.t, item.frame.key)) {
        await writer.push({ ...synthFrame(synth, item.index), tMicros: item.t });
        result.frames.push({ tMicros: item.t, index: item.index });
        const previous = activity.at(-1);
        if (previous && item.t - previous.to <= 500000) previous.to = item.t + 16667;
        else activity.push({ from: item.t, to: item.t + 16667 });
      }
    }
    if (writer) await writer.finish(durationMs * 1000);
    const manifest: RecordingManifest =
      writer && result.frames.length
        ? {
            v: 1,
            state: "complete",
            codec: SYNTH_CODEC,
            width: synth.widthMbs * 16,
            height: synth.heightMbs * 16,
            firstMicros: result.frames[0]?.tMicros ?? null,
            lastMicros: writer.entries.at(-1)?.endMicros ?? null,
            bytes: statSync(join(dir, "video.mp4")).size,
            fragments: writer.entries.length,
            activity,
            gaps: gate.gaps,
            finalized: true,
          }
        : { ...emptyManifest("none"), gaps: gate.gaps };
    writeManifest(dir, manifest);
    writeFileSync(join(o.home, `seed-${id}.json`), `${JSON.stringify(result)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return result;
  } finally {
    writer?.close();
    log.close();
  }
}
