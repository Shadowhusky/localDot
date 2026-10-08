import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BROWSER_RECORDING_DIR,
  RECORDING_DIR,
  RECORDING_FRAGMENTS,
  RECORDING_JOURNAL,
  RECORDING_VIDEO,
  ULID_PATTERN,
} from "@localdot/protocol";
import { readManifest, writeManifest } from "../recorder/manifest.ts";
export interface RetentionPolicy {
  maxBytes: number;
  maxAgeDays: number;
}
export function retentionFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  function positive(raw: string | undefined, fallback: number) {
    const n = raw === undefined ? fallback : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
  return {
    maxBytes: Math.floor(positive(env.LOCALDOT_RECORDINGS_MAX_GB, 20) * 1024 ** 3),
    maxAgeDays: positive(env.LOCALDOT_RECORDINGS_MAX_DAYS, 30),
  };
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
    let started = statSync(session).mtimeMs;
    try {
      const meta = JSON.parse(readFileSync(join(session, "session.json"), "utf8"));
      const t = Date.parse(meta.startedAt);
      if (Number.isFinite(t)) started = t;
    } catch {
      /* use the folder date */
    }
    candidates.push({
      id: String(id),
      started,
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
      for (const name of [RECORDING_VIDEO, RECORDING_FRAGMENTS, RECORDING_JOURNAL])
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
