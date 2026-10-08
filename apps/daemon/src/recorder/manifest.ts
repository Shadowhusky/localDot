import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type ActivitySpan,
  RECORDING_FRAGMENTS,
  RECORDING_JOURNAL,
  RECORDING_MANIFEST,
  RECORDING_VIDEO,
  RecordingManifest,
} from "@localdot/protocol";

export function hasRecordingData(directory: string): boolean {
  if (existsSync(join(directory, RECORDING_FRAGMENTS))) return true;
  try {
    if (statSync(join(directory, RECORDING_VIDEO)).size > 0) return true;
  } catch {}
  try {
    return readdirSync(join(directory, RECORDING_JOURNAL)).some(
      (name) =>
        name.endsWith(".bin") && statSync(join(directory, RECORDING_JOURNAL, name)).size > 0,
    );
  } catch {
    return false;
  }
}

export const ACTIVITY_SOFT_CAP = 150_000;
export type ManifestRead =
  | { ok: true; manifest: RecordingManifest }
  | { ok: false; reason: string };
export function writeManifest(dir: string, m: RecordingManifest): void {
  const manifest = RecordingManifest.parse(m);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.manifest-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, join(dir, RECORDING_MANIFEST));
  } finally {
    rmSync(temp, { force: true });
  }
}
export function readManifest(dir: string): ManifestRead | null {
  let text: string;
  try {
    text = readFileSync(join(dir, RECORDING_MANIFEST), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { ok: false, reason: "the recording's manifest is unreadable" };
  }
  try {
    const result = RecordingManifest.safeParse(JSON.parse(text));
    return result.success
      ? { ok: true, manifest: result.data }
      : { ok: false, reason: "the recording's manifest is invalid" };
  } catch {
    return { ok: false, reason: "the recording's manifest is invalid" };
  }
}
export function capActivity(
  spans: readonly ActivitySpan[],
  cap = ACTIVITY_SOFT_CAP,
): ActivitySpan[] {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 200_000)
    throw new RangeError("invalid activity cap");
  let out = spans.map((span) => ({ ...span }));
  while (out.length > cap) {
    const pairs = Math.min(out.length - cap, Math.floor(out.length / 2));
    const merged: ActivitySpan[] = [];
    for (let i = 0; i < pairs * 2; i += 2) {
      const a = out[i];
      const b = out[i + 1];
      if (!a || !b) throw new Error("missing activity span");
      merged.push({ from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) });
    }
    out = [...merged, ...out.slice(pairs * 2)];
  }
  return out;
}
