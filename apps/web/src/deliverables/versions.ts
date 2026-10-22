import { type FileKind, type FileVersion, fileKind, ulidTime } from "@localdot/protocol";
import { timeLabel } from "../agent/thread.ts";
import { bytes } from "../copy/format.ts";

export interface ShownVersion {
  readonly sessionId: string;
  readonly version: number | null;
}

export function findVersion(
  versions: readonly FileVersion[],
  shown: ShownVersion,
): FileVersion | undefined {
  return versions.find((v) => v.sessionId === shown.sessionId && v.version === shown.version);
}
export const versionKey = (v: ShownVersion) => `${v.sessionId}.${v.version ?? 0}`;

// The version shown and the one before it that can still be read, when both are numbered text.
export function comparePair(
  name: string,
  versions: readonly FileVersion[],
  shown: FileVersion | undefined,
): [FileVersion, FileVersion] | null {
  const kind = fileKind(name);
  if (!shown || shown.version === null || (kind !== "text" && kind !== "table")) return null;
  const before = versions.filter((v) => v.available && v.version !== null && v.label < shown.label);
  const from = before.at(-1);
  return from ? [from, shown] : null;
}

// "Today 9:41 · 12 KB": when the version was handed over, and its size.
export function versionDetail(v: FileVersion, now = Date.now()): string {
  return `${timeLabel(ulidTime(v.sessionId) + v.tMs, now)} · ${bytes(v.bytes)}`;
}

export const previewable = (kind: FileKind) => kind !== "attachment";
