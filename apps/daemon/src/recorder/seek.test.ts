import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNTH_CODEC, synthFrame } from "@localdot/stage/testing";
import { ALL_FORMATS, EncodedPacketSink, Input, StreamSource } from "mediabunny";
import { afterEach, describe, expect, it } from "vitest";
import { openRecordingView, type RecordingView } from "./view.ts";
import { RecordingWriter } from "./writer.ts";

const o = { widthMbs: 4, heightMbs: 4, keyEvery: 12 };
const roots: string[] = [];
const writers: RecordingWriter[] = [];
const views: RecordingView[] = [];
const inputs: Input[] = [];
afterEach(() => {
  for (const input of inputs.splice(0)) input.dispose();
  for (const view of views.splice(0)) view.close();
  for (const writer of writers.splice(0)) writer.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// VFR arrival times: bursts at ~60 fps with jitter, separated by still stretches (Selkies sends
// nothing for a still screen), starting well after session time 0.
function arrivals(n: number): number[] {
  const t: number[] = [];
  let at = 2_345_678;
  for (let i = 0; i < n; i++) {
    t.push(at);
    at += i % 30 === 29 ? 2_500_000 + i * 11 : 16_000 + ((i * 7919) % 1500);
  }
  return t;
}

function sinkOf(view: RecordingView) {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new StreamSource({ getSize: () => view.size, read: (s, e) => view.read(s, e) }),
  });
  inputs.push(input);
  return {
    input,
    sink: input.getPrimaryVideoTrack().then((track) => new EncodedPacketSink(track as never)),
  };
}

async function expectExactSeeks(sink: EncodedPacketSink, times: number[], upTo: number) {
  for (let i = 0; i < upTo; i++) {
    const a = times[i] as number;
    const next = times[i + 1] ?? a + 16_667;
    for (const q of [a, a + 1, Math.floor((a + next) / 2), next - 1]) {
      expect((await sink.getPacket(q / 1e6))?.microsecondTimestamp).toBe(a);
      expect((await sink.getKeyPacket(q / 1e6))?.microsecondTimestamp).toBe(
        times[Math.floor(i / o.keyEvery) * o.keyEvery],
      );
    }
  }
  expect(await sink.getPacket(((times[0] as number) - 1) / 1e6)).toBeNull();
}

describe("seek accuracy (Review Focus 1)", () => {
  it("returns, for any session time, the frame on screen then and the key frame to decode from — live and finished", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local dot's seek-"));
    roots.push(dir);
    const times = arrivals(150);
    const w = new RecordingWriter({ dir, codec: SYNTH_CODEC, width: 64, height: 64 });
    writers.push(w);
    await w.start();
    for (let i = 0; i < times.length; i++) {
      const f = synthFrame(o, i);
      await w.push({ tMicros: times[i] as number, key: f.key, data: f.data });
    }
    // Mid-recording: the committed fragments only, served with a fresh mfra.
    const committed = w.entries.at(-1)?.endMicros ?? 0;
    const upTo = times.filter((t) => t < committed).length - 1;
    expect(upTo).toBeGreaterThan(90);
    const liveView = openRecordingView(dir, { complete: false, entries: w.entries });
    views.push(liveView);
    const live = sinkOf(liveView);
    await expectExactSeeks(await live.sink, times, upTo);
    live.input.dispose();
    inputs.splice(inputs.indexOf(live.input), 1);
    liveView.close();
    views.splice(views.indexOf(liveView), 1);
    await w.finish((times.at(-1) as number) + 16_667);
    const doneView = openRecordingView(dir, { complete: true });
    views.push(doneView);
    const done = sinkOf(doneView);
    await expectExactSeeks(await done.sink, times, times.length);
    done.input.dispose();
    inputs.splice(inputs.indexOf(done.input), 1);
    doneView.close();
    views.splice(views.indexOf(doneView), 1);
  });
});
