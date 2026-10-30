import { describe, expect, it } from "vitest";
import {
  ActivitySpan,
  emptyManifest,
  FragmentEntry,
  RecordingGap,
  RecordingInfo,
  RecordingManifest,
  RecordingState,
  RecordingStorage,
  SessionCard,
  SessionIndexPage,
} from "./recording.ts";

const full = () => ({
  ...emptyManifest("complete"),
  codec: "avc1.f40033",
  width: 2560,
  height: 1600,
  firstMicros: 312_000,
  lastMicros: 9_000_000,
  bytes: 1234,
  fragments: 3,
  finalized: true,
  activity: [{ from: 312_000, to: 900_000 }],
  gaps: [{ from: 1_000_000, to: 2_000_000, reason: "user-control" as const }],
});
const card = () => ({
  id: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
  title: null,
  startedAt: "2026-10-04T10:00:00.000Z",
  durationMs: 1000,
  verdict: "done",
  steps: 2,
  failedSteps: 0,
  coverFrameId: null,
  screen: { w: 2560, h: 1600, scale: 2 },
  recording: { state: "complete", bytes: 10 },
});

describe("recording format", () => {
  it("accepts every empty state, a complete recording and actual observed H.264 profiles", () => {
    for (const state of RecordingState.options) {
      expect(RecordingManifest.parse(emptyManifest(state, "no stream"))).toMatchObject({
        state,
        note: "no stream",
        finalized: false,
      });
    }
    expect(RecordingManifest.parse(full())).toMatchObject({
      codec: "avc1.f40033",
      finalized: true,
    });
    expect(RecordingManifest.parse({ ...full(), codec: "avc1.42c033" }).codec).toBe("avc1.42c033");
  });

  it("requires a version and explicit finalization, and rejects unsafe codec and media values", () => {
    for (const patch of [
      { v: 2 },
      { finalized: undefined },
      { codec: "avc1.F4001F; rm -rf" },
      { codec: "avc1.12345" },
      { width: 16_385 },
      { height: 0 },
      { bytes: -1 },
      { fragments: 1.5 },
      { firstMicros: -1 },
      { lastMicros: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(RecordingManifest.safeParse({ ...full(), ...patch }).success).toBe(false);
    }
  });

  it("records what a compacted video took before, and the storage summary", () => {
    const compacted = { ...full(), compacted: { sourceBytes: 98_765 } };
    expect(RecordingManifest.parse(compacted).compacted).toEqual({ sourceBytes: 98_765 });
    expect(RecordingManifest.parse(full()).compacted).toBeUndefined();
    expect(RecordingManifest.safeParse({ ...full(), compacted: { sourceBytes: 0 } }).success).toBe(
      false,
    );
    const storage = {
      videos: 2,
      bytes: 10,
      savedBytes: 90,
      maxBytes: 20,
      maxAgeDays: 30,
      framesBytes: 5,
      framesMaxAgeDays: 180,
    };
    expect(RecordingStorage.parse(storage)).toEqual(storage);
    expect(RecordingStorage.safeParse({ ...storage, savedBytes: -1 }).success).toBe(false);
  });

  it("rejects reversed media and activity spans while permitting instantaneous activity", () => {
    expect(RecordingManifest.safeParse({ ...full(), firstMicros: 10, lastMicros: 9 }).success).toBe(
      false,
    );
    expect(ActivitySpan.parse({ from: 5, to: 5 })).toEqual({ from: 5, to: 5 });
    expect(RecordingManifest.safeParse({ ...full(), activity: [{ from: 5, to: 4 }] }).success).toBe(
      false,
    );
  });

  it("accepts open control or failure gaps and rejects reversed or unknown gaps", () => {
    expect(RecordingGap.parse({ from: 20, to: null, reason: "user-control" }).to).toBeNull();
    expect(RecordingGap.parse({ from: 20, to: 20, reason: "disk-full" }).to).toBe(20);
    expect(RecordingGap.safeParse({ from: 20, to: 19, reason: "stream-lost" }).success).toBe(false);
    expect(RecordingGap.safeParse({ from: 20, to: null, reason: "other" }).success).toBe(false);
  });

  it("requires ordered fragment byte offsets, one-based sequence and an ordered time span", () => {
    const entry = { seq: 1, moofOffset: 200, endOffset: 300, startMicros: 0, endMicros: 1 };
    expect(FragmentEntry.parse(entry)).toEqual(entry);
    for (const patch of [{ seq: 0 }, { endOffset: 200 }, { endOffset: 199 }, { startMicros: 2 }]) {
      expect(FragmentEntry.safeParse({ ...entry, ...patch }).success).toBe(false);
    }
  });

  it("keeps media times and byte offsets exact through serialization", () => {
    const entry = {
      seq: 5,
      moofOffset: 5_000_000_000,
      endOffset: 5_000_010_000,
      startMicros: 8_000_000_000,
      endMicros: 8_000_030_000,
    };
    expect(FragmentEntry.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  });
});

describe("session replay API", () => {
  it("validates completed and live session cards with optional screen and thumbnail", () => {
    expect(SessionCard.parse(card()).verdict).toBe("done");
    expect(
      SessionCard.parse({ ...card(), durationMs: null, verdict: "live", screen: null }).screen,
    ).toBeNull();
    expect(SessionCard.parse({ ...card(), coverFrameId: card().id }).coverFrameId).toBe(card().id);
  });

  it("rejects invalid identities, dates, counts and dimensions", () => {
    for (const patch of [
      { id: "../../etc" },
      { coverFrameId: "bad" },
      { startedAt: "yesterday" },
      { durationMs: -1 },
      { failedSteps: -1 },
      { screen: { w: 0, h: 800, scale: 1 } },
      { recording: { state: "complete", bytes: -1 } },
    ]) {
      expect(SessionCard.safeParse({ ...card(), ...patch }).success).toBe(false);
    }
  });

  it("round-trips session index pages, empty pages and recording snapshots", () => {
    expect(SessionIndexPage.parse({ sessions: [card()], next: "cursor" }).sessions).toHaveLength(1);
    expect(SessionIndexPage.parse({ sessions: [], next: null }).next).toBeNull();
    const snapshot = { manifest: full(), live: false, upto: 3, servedBytes: 1234 };
    expect(RecordingInfo.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(RecordingInfo.safeParse({ ...snapshot, upto: -1 }).success).toBe(false);
    expect(RecordingInfo.safeParse({ ...snapshot, servedBytes: 1.5 }).success).toBe(false);
  });
});
