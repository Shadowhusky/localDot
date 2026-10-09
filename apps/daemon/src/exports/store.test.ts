import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HostExport, ulid } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_EXPORT_LIMITS, ExportStore } from "./store.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-09T15:00:00Z");

function record(patch: Partial<HostExport> = {}): HostExport {
  return {
    id: ulid(),
    sessionId: ulid(),
    screen: "desktop",
    name: "localdot-2026-10-09-1500.mp4",
    phase: "done",
    createdAt: NOW,
    done: 30,
    total: 30,
    elapsedMs: 1000,
    leftMs: null,
    bytes: 100,
    durationS: 1,
    error: null,
    request: {
      sessionId: ulid(),
      fromMs: 0,
      toMs: 1000,
      speed: 1,
      skipIdle: false,
      captions: true,
      overlays: true,
      size: { w: 1280, h: 800 },
      fps: 30,
      quality: "high",
      format: "mp4",
    },
    ...patch,
  };
}

function storeWith(records: HostExport[], limits = DEFAULT_EXPORT_LIMITS) {
  const home = mkdtempSync(join(tmpdir(), "export-store-"));
  homes.push(home);
  const store = new ExportStore(home, limits);
  for (const entry of records) {
    store.set(entry);
    writeFileSync(entry.phase === "done" ? store.file(entry) : store.partFile(entry), "x");
  }
  store.save();
  return { home, store };
}

describe("ExportStore", () => {
  it("keeps its list across a restart, newest first", () => {
    const older = record({ createdAt: NOW - 1000 });
    const newer = record();
    const { home } = storeWith([older, newer]);
    expect(new ExportStore(home).list().map((entry) => entry.id)).toEqual([newer.id, older.id]);
  });

  it("lets go of videos past their age, and their files", () => {
    const old = record({ createdAt: NOW - 8 * DAY });
    const recent = record({ createdAt: NOW - DAY });
    const { store } = storeWith([old, recent]);
    expect(store.sweep(NOW)).toEqual([old.id]);
    expect(store.get(old.id)).toBeUndefined();
    expect(existsSync(store.file(old))).toBe(false);
    expect(existsSync(store.file(recent))).toBe(true);
  });

  it("keeps only the newest few", () => {
    const entries = Array.from({ length: 5 }, (_, n) => record({ createdAt: NOW - n * 1000 }));
    const { store } = storeWith(entries, { ...DEFAULT_EXPORT_LIMITS, maxCount: 3 });
    expect(store.sweep(NOW).sort()).toEqual([entries[3]?.id, entries[4]?.id].sort());
    expect(store.list()).toHaveLength(3);
  });

  it("drops the oldest while the videos together are over the size limit", () => {
    const entries = [
      record({ createdAt: NOW, bytes: 400 }),
      record({ createdAt: NOW - 1000, bytes: 400 }),
      record({ createdAt: NOW - 2000, bytes: 400 }),
    ];
    const { store } = storeWith(entries, { ...DEFAULT_EXPORT_LIMITS, maxBytes: 1000 });
    expect(store.sweep(NOW)).toEqual([entries[2]?.id]);
  });

  it("never touches a video being made, and clears files no video names", () => {
    const making = record({ phase: "making", createdAt: NOW - 30 * DAY });
    const { store } = storeWith([making], { ...DEFAULT_EXPORT_LIMITS, maxCount: 0 });
    writeFileSync(join(store.dir, "stray.mp4"), "x");
    expect(store.sweep(NOW)).toEqual([]);
    expect(existsSync(store.partFile(making))).toBe(true);
    expect(readdirSync(store.dir).sort()).toEqual(["exports.json", `${making.id}.mp4.part`].sort());
  });

  it("starts afresh from an unreadable list", () => {
    const { home, store } = storeWith([record()]);
    writeFileSync(join(store.dir, "exports.json"), "{not json");
    expect(new ExportStore(home).list()).toEqual([]);
  });

  it("names files by id alone, inside its own folder", () => {
    const entry = record();
    const { store } = storeWith([entry]);
    expect(store.file(entry)).toBe(join(store.dir, `${entry.id}.mp4`));
  });
});
