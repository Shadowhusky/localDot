import { type RecordingInfo, ScreenName, ULID_PATTERN } from "@localdot/protocol";
import type { SessionModel, View } from "@localdot/stage";
import type { ReplaySource } from "../stage/worker-protocol.ts";

export const RECORDING_CACHE_BYTES = 32 * 1024 * 1024;

export function sessionResourceUrl(source: ReplaySource, resource: string): string {
  if (!ULID_PATTERN.test(source.sessionId)) throw new RangeError("Invalid recording session.");
  const origin = new URL(source.origin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new RangeError("Invalid recording origin.");
  }
  return `${origin.origin}/api/sessions/${source.sessionId}/${resource}`;
}

export function recordingUrl(source: ReplaySource): string {
  const url = new URL(sessionResourceUrl(source, "recording/video.mp4"));
  const screen = ScreenName.parse(source.screen ?? "desktop");
  if (screen === "browser") url.searchParams.set("screen", screen);
  const upto = source.video?.upto;
  if (upto !== undefined && upto !== null) {
    if (!Number.isSafeInteger(upto) || upto < 0)
      throw new RangeError("Invalid recording snapshot.");
    url.searchParams.set("upto", String(upto));
  }
  const bytes = source.video?.bytes;
  if (bytes !== undefined) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Invalid recording size.");
    url.searchParams.set("bytes", String(bytes));
  }
  return url.toString();
}

// What a reader opens: a live recording's committed fragments, or a finished one's file at its
// present size. Compaction can later replace that file with a smaller one, which the daemon then
// refuses to mix into this reader's requests.
export function recordingSnapshot(info: RecordingInfo): NonNullable<ReplaySource["video"]> {
  return info.live ? { upto: info.upto } : { upto: null, bytes: info.servedBytes };
}

export function replayGeometry(
  model: SessionModel,
  source: ReplaySource,
  tMs = Number.POSITIVE_INFINITY,
) {
  const screen = source.screen ?? "desktop";
  const changes = model.screenChanges ?? [];
  const selected = changes.findLast((change) => change.screen === screen && change.t <= tMs);
  return (
    selected?.geometry ??
    (screen === "desktop"
      ? model.screen
      : changes.find((change) => change.screen === screen)?.geometry) ??
    source.geometry ??
    null
  );
}

export function replayView(source: ReplaySource, view: View): View {
  const { screenRevision: _revision, ...rest } = view;
  return { ...rest, screen: source.screen ?? "desktop" };
}

export function replayRequestInit(source: ReplaySource): RequestInit {
  return {
    headers: { authorization: source.authorization },
    credentials: "same-origin",
    redirect: "error",
  };
}
