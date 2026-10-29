import type { SessionCard } from "@localdot/protocol";
import { buildPlaybackMap, emptyModel, type Tick } from "@localdot/stage";
import { describe, expect, it } from "vitest";
import {
  byDay,
  compareFrames,
  dayLabel,
  followRule,
  gapCard,
  inFilter,
  libraryTotal,
  matchesSearch,
  previewMeta,
  recordedLabel,
  replayKey,
  rowMeta,
  scrubberModel,
  speedLabel,
  suggestedExportName,
  taskMeta,
  timeLabel,
  verdictGlyph,
} from "./replay-view.ts";

const chapters = [
  { id: "first", label: "First step", startT: 0, endT: 1000, status: "ok" as const },
  { id: "second", label: "Second step", startT: 61_000, endT: 62_000, status: "failed" as const },
];
const busy = [
  { from: 0, to: 1000 },
  { from: 61_000, to: 62_000 },
];
const map = buildPlaybackMap(0, 62_000, busy, true);
const plain = buildPlaybackMap(0, 62_000, busy, false);

describe("replay controls and timeline presentation", () => {
  it("places chapters on the playback track, idle skipped", () => {
    const compressed = scrubberModel({ chapters, ticks: [], map, gaps: [], widthPx: 400 });
    expect(compressed.durationPlayMs).toBe(2400);
    expect(compressed.chapters[0]?.x1).toBeCloseTo(1000 / 2400);
    expect(compressed.chapters[1]?.x0).toBeCloseTo(1400 / 2400);
    const original = scrubberModel({ chapters, ticks: [], map: plain, gaps: [], widthPx: 400 });
    expect(original.chapters[1]?.x0).toBeCloseTo(61_000 / 62_000);
  });
  it("buckets 14 000 ticks into at most widthPx / 4 buckets, keeping the strongest tone", () => {
    const ticks: Tick[] = Array.from({ length: 14_000 }, (_, index) => ({
      t: (index * 62_000) / 14_000,
      kind: "click",
      label: "Click A",
      tone: "neutral",
    }));
    ticks[1] = { t: 0, kind: "takeover", label: "Control", tone: "user" };
    ticks[2] = { t: 0, kind: "approval", label: "Approval", tone: "attention" };
    ticks[3] = { t: 0, kind: "tool-failed", label: "Failed", tone: "failure" };
    const view = scrubberModel({ chapters, ticks, map, gaps: [], widthPx: 403 });
    expect(view.ticks.length).toBeLessThanOrEqual(100);
    expect(view.ticks.reduce((count, tick) => count + tick.count, 0)).toBe(14_000);
    expect(view.ticks[0]?.tone).toBe("failure");
    expect(view.ticks[0]?.kinds).toContain("approval");
    const combined = scrubberModel({
      chapters: [],
      ticks: ticks.slice(0, 13),
      map,
      gaps: [],
      widthPx: 4,
    });
    expect(combined.ticks[0]?.label).toBe("Click A and 12 more");
    expect(scrubberModel({ chapters: [], ticks, map, gaps: [], widthPx: 0 }).ticks).toEqual([]);
  });
  it("draws idle bands with the time they skip and gap bands by reason", () => {
    const view = scrubberModel({
      chapters,
      ticks: [],
      map,
      gaps: [
        { from: 1_000_000, to: 61_000_000, reason: "user-control" },
        { from: 61_000_000, to: null, reason: "disk-full" },
        { from: 70_000_000, to: 80_000_000, reason: "stream-lost" },
      ],
      widthPx: 400,
    });
    expect(view.idle).toEqual([{ x0: 1000 / 2400, x1: 1400 / 2400, skippedMs: 59_600 }]);
    expect(view.gaps).toEqual([
      { x0: 1000 / 2400, x1: 1400 / 2400, reason: "user-control" },
      { x0: 1400 / 2400, x1: 1, reason: "disk-full" },
    ]);
  });
  it.each([
    [7000, "0:07"],
    [723_000, "12:03"],
    [3_723_000, "1:02:03"],
    [-1, "0:00"],
  ] as const)("formats time %s", (time, label) => {
    expect(timeLabel(time)).toBe(label);
  });
  it("labels honest speed", () => {
    expect(speedLabel(1, false)).toBeNull();
    expect(speedLabel(1, true)).toBe("Idle skipped");
    expect(speedLabel(4, false)).toBe("Playing at 4×");
    expect(speedLabel(4, true)).toBe("Playing at 4× · idle skipped");
    expect(speedLabel(0.5, false)).toBe("Playing at ½×");
  });
  it.each([
    ["user-control", "You had control here", "Nothing was recorded while you were in control."],
    [
      "stream-lost",
      "The picture dropped here",
      "localDot lost the computer's stream. Steps are shown from screenshots.",
    ],
    [
      "disk-full",
      "Recording stopped: the disk was full",
      "Steps are shown from screenshots. Free some space and new tasks record again.",
    ],
    ["size-cap", "Recording stopped at the size limit", "Steps are shown from screenshots."],
    ["recorder-error", "Recording stopped", "Steps are shown from screenshots."],
    ["expired", "The video was removed to save space", "Steps are shown from screenshots."],
    ["none", "No video for this task", "Steps are shown from screenshots."],
    ["failed", "No video for this task", "Steps are shown from screenshots."],
  ] as const)("names the %s gap card", (kind, title, body) => {
    expect(gapCard(kind)).toEqual({ title, body });
  });
  it("maps keys and ignores them in fields and with modifiers", () => {
    const input = { key: " ", metaKey: false, ctrlKey: false, altKey: false, targetIsField: false };
    expect(replayKey(input)).toEqual({ kind: "toggle-play" });
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "targetIsField"])
      expect(replayKey({ ...input, [modifier]: true })).toBeNull();
    expect(
      ["K", "ArrowLeft", "ArrowRight", "J", "L", "[", "]", "B", "I", "o", "Escape"].map((key) =>
        replayKey({ ...input, key }),
      ),
    ).toEqual([
      { kind: "pause" },
      { kind: "step", dir: -1 },
      { kind: "step", dir: 1 },
      { kind: "jump", ms: -10_000 },
      { kind: "jump", ms: 10_000 },
      { kind: "speed", dir: -1 },
      { kind: "speed", dir: 1 },
      { kind: "compare" },
      { kind: "mark", edge: "in" },
      { kind: "mark", edge: "out" },
      { kind: "exit" },
    ]);
  });
  it("compares a step's screen before and after using a strictly earlier observation", () => {
    const model = emptyModel();
    model.steps.push({ id: "step", kind: "gui", startT: 1000 });
    model.stepIndex.set("step", 0);
    expect(compareFrames(model, "step")).toEqual({ before: null, after: null });
    model.observes.push(
      { t: 0, frameId: "initial" },
      { t: 999, frameId: "before" },
      { t: 1000, frameId: "same-time" },
      { t: 1200, frameId: "after" },
    );
    model.frames.set("step", "after");
    expect(compareFrames(model, "step")).toEqual({ before: "before", after: "after" });
    model.steps[0] = { id: "step", kind: "gui", startT: 0 };
    expect(compareFrames(model, "step")).toEqual({ before: "initial", after: "after" });
  });
  it("follows to live only at the live edge, refreshes near it, stays when stepping back", () => {
    const input = { live: true, playing: true, tMs: 9750, lastMs: 10_000, liveNowMs: 12_000 };
    expect(followRule(input)).toBe("go-live");
    expect(followRule({ ...input, liveNowMs: 12_001 })).toBe("refresh");
    expect(followRule({ ...input, tMs: 9749 })).toBe("stay");
    expect(followRule({ ...input, playing: false })).toBe("stay");
    expect(followRule({ ...input, live: false })).toBe("stay");
    expect(followRule({ ...input, lastMs: null })).toBe("stay");
  });
  it("suggests an export name with the date, never the title", () => {
    expect(suggestedExportName(new Date(2026, 9, 2, 10, 12))).toBe("localdot-2026-10-02-1012.mp4");
  });
});

describe("the task library's words", () => {
  const now = new Date(2026, 9, 8, 19, 30);
  const at = (day: number, hour: number, minute: number) =>
    new Date(2026, 9, day, hour, minute).toISOString();
  const card = (patch: Partial<SessionCard>): SessionCard => ({
    id: "01M4D263DDHCRM52FMG340DDF3",
    title: "Monthly report",
    startedAt: at(8, 9, 53),
    durationMs: 33_000,
    verdict: "done",
    steps: 3,
    failedSteps: 0,
    coverFrameId: null,
    screen: null,
    recording: { state: "complete", bytes: 10 },
    ...patch,
  });
  it("names days the way people say them", () => {
    expect(dayLabel(at(8, 0, 1), now)).toBe("Today");
    expect(dayLabel(at(7, 23, 59), now)).toBe("Yesterday");
    expect(dayLabel(at(6, 12, 0), now)).toMatch(/^(?=.*Tuesday)(?=.*October)(?=.*6)/);
    expect(dayLabel(new Date(2025, 9, 6).toISOString(), now)).toMatch(/2025/);
  });
  it("gives each row its start and length, and a running task no length", () => {
    expect(taskMeta(card({}))).toBe("09:53 · 0:33");
    expect(taskMeta(card({ verdict: "live", durationMs: null }))).toBe("09:53 · Running");
    expect(recordedLabel(card({}), now)).toBe("Today 09:53");
    expect(recordedLabel(card({ verdict: "live", durationMs: null }), now)).toBe(
      "Running · Today 09:53",
    );
  });
  it("says on each row when it ran, how long, its steps and how it ended", () => {
    expect(rowMeta(card({}), false)).toBe("09:53 · 3 steps");
    expect(rowMeta(card({ verdict: "stopped", steps: 1 }), true)).toBe(
      "09:53 · 0:33 · 1 step · you stopped it",
    );
    expect(rowMeta(card({ verdict: "live", durationMs: null }), true)).toBe(
      "09:53 · 3 steps · running",
    );
    expect(previewMeta(card({}), now, "$0.21")).toBe("Today 09:53 · 0:33 · 3 steps · $0.21");
  });
  it("filters finished and stopped recordings, and counts what the library holds", () => {
    const verdicts = ["done", "live", "stopped", "error"] as const;
    expect(verdicts.filter((verdict) => inFilter({ verdict }, "finished"))).toEqual(["done"]);
    expect(verdicts.filter((verdict) => inFilter({ verdict }, "stopped"))).toEqual([
      "stopped",
      "error",
    ]);
    const big = card({ recording: { state: "complete", bytes: 2.1 * 1024 ** 3 } });
    expect(libraryTotal([big, card({})], false)).toBe("2 recordings · 2.1 GB");
    expect(libraryTotal([card({ recording: { state: "none", bytes: 0 } })], true)).toBe(
      "1+ recordings",
    );
    // Once the daemon measures a task's folder, its screenshots and history count too.
    expect(libraryTotal([{ ...big, diskBytes: 3 * 1024 ** 3 }, card({})], false)).toBe(
      "2 recordings · 3.0 GB",
    );
  });
  it("draws every verdict as a glyph with words", () => {
    expect(
      (["done", "live", "stopped", "error", "interrupted"] as const).map(verdictGlyph),
    ).toEqual([
      { state: "done", label: "Done" },
      { state: "doing", label: "Running" },
      { state: "skipped", label: "Stopped" },
      { state: "failed", label: "Failed" },
      { state: "failed", label: "Interrupted" },
    ]);
  });
  it("matches every searched word in any order and case, and an empty search matches all", () => {
    expect(matchesSearch({ title: "Email the monthly totals" }, " TOTALS email ")).toBe(true);
    expect(matchesSearch({ title: "Email the monthly totals" }, "weekly totals")).toBe(false);
    expect(matchesSearch({ title: null }, "untitled")).toBe(true);
    expect(matchesSearch({ title: "Anything" }, "")).toBe(true);
  });
  it("groups newest-first tasks into runs of one day", () => {
    const days = byDay(
      [
        card({ id: "01M4D263DDHCRM52FMG340DDF1", startedAt: at(8, 10, 0) }),
        card({ id: "01M4D263DDHCRM52FMG340DDF2", startedAt: at(8, 9, 0) }),
        card({ id: "01M4D263DDHCRM52FMG340DDF4", startedAt: at(7, 9, 0) }),
      ],
      now,
    );
    expect(days.map(({ day, cards }) => [day, cards.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
    ]);
  });
});
