import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseEvent,
  recordingDirectory,
  type ScreenName,
  SESSION_SUMMARY,
  SessionCard,
  type SessionOrigin,
  ULID_PATTERN,
  ulidTime,
} from "@localdot/protocol";
import { UnknownSessionError } from "../event-log.ts";
import { hasRecordingData, readManifest } from "../recorder/manifest.ts";
import { streamEventLines } from "./ndjson.ts";
export interface SessionSummaryFile extends SessionCard {
  logBytes: number;
}
export function recordingCard(
  home: string,
  id: string,
  screen: ScreenName = "desktop",
): SessionCard["recording"] {
  const directory = join(home, "sessions", id, recordingDirectory(screen));
  const read = readManifest(directory);
  return read?.ok
    ? { state: read.manifest.state, bytes: read.manifest.bytes }
    : { state: read || hasRecordingData(directory) ? "failed" : "none", bytes: 0 };
}
export function recordingCards(home: string, id: string): NonNullable<SessionCard["recordings"]> {
  return { desktop: recordingCard(home, id), browser: recordingCard(home, id, "browser") };
}
export async function summarizeSession(
  home: string,
  id: string,
  opts: { live: boolean },
): Promise<SessionSummaryFile> {
  if (!ULID_PATTERN.test(id)) throw new RangeError("invalid session id");
  const dir = join(home, "sessions", id);
  if (!existsSync(dir)) throw new UnknownSessionError(id);
  let title: string | null = null;
  let startedAt = new Date(ulidTime(id)).toISOString();
  try {
    const meta = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    if (typeof meta.title === "string") title = meta.title.slice(0, 200);
    if (typeof meta.startedAt === "string" && Number.isFinite(Date.parse(meta.startedAt)))
      startedAt = new Date(meta.startedAt).toISOString();
  } catch {
    /* old sessions derive metadata from their id */
  }
  const file = join(dir, "events.jsonl");
  const logBytes = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  let first = 0,
    last = 0,
    steps = 0,
    failedSteps = 0;
  let verdict: SessionCard["verdict"] = opts.live ? "live" : "interrupted";
  let endedAt: number | undefined;
  let coverFrameId: string | null = null;
  let screen: SessionCard["screen"] = null;
  let origin: SessionOrigin | undefined;
  for await (const line of streamEventLines(file)) {
    const e = parseEvent(JSON.parse(line));
    last = e.t;
    switch (e.type) {
      case "session.start":
        first = e.t;
        screen = e.data.screen;
        title = e.data.title ?? title;
        origin = e.data.origin ?? origin;
        break;
      case "session.end":
        endedAt = e.t;
        if (!opts.live) verdict = e.data.reason;
        break;
      case "step.start":
        steps++;
        break;
      case "step.end":
        if (e.data.status !== "ok") failedSteps++;
        break;
      case "observe":
        coverFrameId = e.data.frameId;
        break;
    }
  }
  return {
    ...SessionCard.parse({
      id,
      title,
      startedAt,
      durationMs: Math.max(0, Math.floor(((endedAt ?? last) - first) / 1000)),
      verdict,
      steps,
      failedSteps,
      coverFrameId,
      screen,
      recording: recordingCard(home, id),
      recordings: recordingCards(home, id),
      ...(origin ? { origin } : {}),
    }),
    logBytes,
  };
}
export function writeSummary(home: string, summary: SessionSummaryFile): void {
  const card = SessionCard.parse(summary);
  if (!Number.isSafeInteger(summary.logBytes) || summary.logBytes < 0)
    throw new RangeError("invalid summary size");
  const file = join(home, "sessions", card.id, SESSION_SUMMARY),
    temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ ...card, logBytes: summary.logBytes })}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
export function readSummary(home: string, id: string): SessionSummaryFile | null {
  if (!ULID_PATTERN.test(id)) return null;
  try {
    const raw = JSON.parse(readFileSync(join(home, "sessions", id, SESSION_SUMMARY), "utf8"));
    const card = SessionCard.parse(raw);
    if (card.id !== id || !Number.isSafeInteger(raw.logBytes) || raw.logBytes < 0) return null;
    return { ...card, logBytes: raw.logBytes };
  } catch {
    return null;
  }
}
