import type { ActivitySpan, RecordingGap } from "@localdot/protocol";
import { chapters, type SessionModel } from "@localdot/stage";
import type { ApiClient } from "../lib/api.ts";
import { type ReplayState, replayOrigin } from "../replay/useReplay.ts";
import type { ReplaySource } from "../stage/worker-protocol.ts";

export interface ExportContext {
  sessionId: string;
  model: SessionModel;
  activity: ActivitySpan[];
  gaps: RecordingGap[];
  source: ReplaySource;
  whole: { fromMs: number; toMs: number };
  chapter: { fromMs: number; toMs: number } | null;
  selection: { fromMs: number; toMs: number } | null;
  // Where the playhead was, for the picture the export opens on.
  atMs: number;
}

export function exportContext(
  api: ApiClient,
  sessionId: string,
  replay: ReplayState,
): ExportContext {
  if (!replay.info || !replay.map) throw new Error("The recording is still loading.");
  const { info, map } = replay;
  const chapter = chapters(replay.model, map.endMs).find(
    (entry) => entry.startT <= replay.tMs && replay.tMs < entry.endT,
  );
  return structuredClone({
    sessionId,
    model: replay.model,
    activity: info.manifest.activity,
    gaps: info.manifest.gaps,
    source: {
      screen: replay.screen,
      ...(info.manifest.width && info.manifest.height
        ? { geometry: { w: info.manifest.width, h: info.manifest.height, scale: 1 } }
        : {}),
      sessionId,
      origin: replayOrigin(api),
      authorization: api.authorization(),
      video:
        info.servedBytes > 0 && !["none", "failed", "expired"].includes(info.manifest.state)
          ? { upto: info.live ? info.upto : null }
          : null,
      gaps: info.manifest.gaps,
    },
    whole: { fromMs: map.startMs, toMs: map.endMs },
    chapter: chapter ? { fromMs: chapter.startT, toMs: chapter.endT } : null,
    selection: replay.selection,
    atMs: replay.tMs,
  });
}
