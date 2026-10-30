import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BROWSER_RECORDING_DIR,
  RECORDING_DIR,
  RECORDING_FRAGMENTS,
  RECORDING_JOURNAL,
  RECORDING_VIDEO,
  type RecordingStorage,
  SESSION_SUMMARY,
  ULID_PATTERN,
} from "@localdot/protocol";
import { COMPACTION_DIR } from "../recorder/compaction.ts";
import { readManifest, writeManifest } from "../recorder/manifest.ts";
export interface RetentionPolicy {
  maxBytes: number;
  maxAgeDays: number;
}
function positive(raw: string | undefined, fallback: number) {
  const n = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
export function retentionFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  return {
    maxBytes: Math.floor(positive(env.LOCALDOT_RECORDINGS_MAX_GB, 20) * 1024 ** 3),
    maxAgeDays: positive(env.LOCALDOT_RECORDINGS_MAX_DAYS, 30),
  };
}
export const FRAMES_MAX_AGE_DAYS = 180;
export function framesMaxAgeFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return positive(env.LOCALDOT_FRAMES_MAX_DAYS, FRAMES_MAX_AGE_DAYS);
}
const FRAMES = "frames";
function framesBytes(session: string): number {
  let names: string[];
  try {
    names = readdirSync(join(session, FRAMES));
  } catch {
    return 0;
  }
  return names.reduce(
    (total, name) =>
      total + (statSync(join(session, FRAMES, name), { throwIfNoEntry: false })?.size ?? 0),
    0,
  );
}
export function recordingStorage(
  home: string,
  policy: RetentionPolicy,
  framesMaxAgeDays = FRAMES_MAX_AGE_DAYS,
): RecordingStorage {
  const storage = {
    videos: 0,
    bytes: 0,
    savedBytes: 0,
    ...policy,
    framesBytes: 0,
    framesMaxAgeDays,
  };
  let ids: string[];
  try {
    ids = readdirSync(join(home, "sessions")).filter((id) => ULID_PATTERN.test(id));
  } catch {
    return storage;
  }
  for (const id of ids) {
    storage.framesBytes += framesBytes(join(home, "sessions", id));
    for (const name of [RECORDING_DIR, BROWSER_RECORDING_DIR]) {
      const dir = join(home, "sessions", id, name);
      const read = readManifest(dir);
      if (!read?.ok || ["none", "expired"].includes(read.manifest.state)) continue;
      const bytes = statSync(join(dir, RECORDING_VIDEO), { throwIfNoEntry: false })?.size ?? 0;
      storage.videos++;
      storage.bytes += bytes;
      storage.savedBytes += Math.max(0, (read.manifest.compacted?.sourceBytes ?? bytes) - bytes);
    }
  }
  return storage;
}
// A finished task's screenshots outlive its videos, as what Replay shows once they expire, until
// their own, longer age. Then all but its cover go: the library's picture and its thumbnails are
// made from that. A task with no summary yet names no cover, so it keeps them all.
export function sweepFrames(o: {
  home: string;
  maxAgeDays: number;
  now: Date;
  isLive(id: string): boolean;
}): { sessions: string[]; freedBytes: number } {
  if (!Number.isFinite(o.now.getTime()) || !Number.isFinite(o.maxAgeDays) || o.maxAgeDays <= 0)
    throw new RangeError("invalid frame retention");
  const result = { sessions: [] as string[], freedBytes: 0 };
  const root = join(o.home, "sessions");
  let ids: string[];
  try {
    ids = readdirSync(root).filter((id) => ULID_PATTERN.test(id));
  } catch {
    return result;
  }
  const oldest = o.now.getTime() - o.maxAgeDays * 86_400_000;
  for (const id of ids) {
    const session = join(root, id);
    let names: string[];
    let cover: unknown;
    try {
      names = readdirSync(join(session, FRAMES));
      if (names.length <= 1 || o.isLive(id) || sessionStarted(session) > oldest) continue;
      cover = JSON.parse(readFileSync(join(session, SESSION_SUMMARY), "utf8")).coverFrameId;
    } catch {
      continue;
    }
    if (typeof cover !== "string" || !names.includes(`${cover}.webp`)) continue;
    for (const name of names) {
      if (name === `${cover}.webp`) continue;
      const file = join(session, FRAMES, name);
      result.freedBytes += statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      rmSync(file, { force: true });
    }
    result.sessions.push(id);
  }
  return result;
}
export function sessionStarted(session: string): number {
  try {
    const t = Date.parse(JSON.parse(readFileSync(join(session, "session.json"), "utf8")).startedAt);
    if (Number.isFinite(t)) return t;
  } catch {
    /* use the folder date */
  }
  return statSync(session).mtimeMs;
}
export function sweepRecordings(o: {
  home: string;
  policy: RetentionPolicy;
  now: Date;
  isLive(id: string): boolean;
}): { expired: string[]; freedBytes: number } {
  const result = { expired: [] as string[], freedBytes: 0 };
  const root = join(o.home, "sessions");
  if (
    !Number.isFinite(o.now.getTime()) ||
    !Number.isFinite(o.policy.maxBytes) ||
    o.policy.maxBytes < 0 ||
    !Number.isFinite(o.policy.maxAgeDays) ||
    o.policy.maxAgeDays < 0
  )
    throw new RangeError("invalid retention policy");
  type Track = {
    dir: string;
    bytes: number;
    manifest: NonNullable<ReturnType<typeof readManifest>> & { ok: true };
  };
  const candidates: { id: string; started: number; bytes: number; tracks: Track[] }[] = [];
  let total = 0;
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return result;
  }
  for (const id of dirs) {
    if (!ULID_PATTERN.test(String(id))) continue;
    const session = join(root, String(id));
    if (!statSync(session, { throwIfNoEntry: false })?.isDirectory()) continue;
    const tracks: Track[] = [];
    const live = o.isLive(String(id));
    let protectedTrack = false;
    for (const name of [RECORDING_DIR, BROWSER_RECORDING_DIR]) {
      const dir = join(session, name);
      if (!statSync(dir, { throwIfNoEntry: false })) continue;
      const read = readManifest(dir);
      if (!read?.ok) {
        protectedTrack = true;
        continue;
      }
      const bytes =
        statSync(join(dir, RECORDING_VIDEO), { throwIfNoEntry: false })?.size ??
        read.manifest.bytes;
      if (!live) total += bytes;
      if (read.manifest.state === "none" || read.manifest.state === "expired") continue;
      if (read.manifest.state === "recording" || !read.manifest.finalized) {
        protectedTrack = true;
        continue;
      }
      tracks.push({ dir, bytes, manifest: read });
    }
    // Both screens share a history entry and retention decision. An unfinished or
    // damaged track protects the session until recovery can establish its ownership.
    if (live || protectedTrack || tracks.length === 0) continue;
    candidates.push({
      id: String(id),
      started: sessionStarted(session),
      bytes: tracks.reduce((n, track) => n + track.bytes, 0),
      tracks,
    });
  }
  candidates.sort((a, b) => a.started - b.started || a.id.localeCompare(b.id));
  for (const item of candidates) {
    if (
      total <= o.policy.maxBytes &&
      o.now.getTime() - item.started <= o.policy.maxAgeDays * 86400_000
    )
      continue;
    for (const track of item.tracks) {
      for (const name of [RECORDING_VIDEO, RECORDING_FRAGMENTS, RECORDING_JOURNAL, COMPACTION_DIR])
        rmSync(join(track.dir, name), { recursive: true, force: true });
      writeManifest(track.dir, {
        ...track.manifest.manifest,
        state: "expired",
        bytes: 0,
        finalized: false,
      });
    }
    total -= item.bytes;
    result.freedBytes += item.bytes;
    result.expired.push(item.id);
  }
  return result;
}
