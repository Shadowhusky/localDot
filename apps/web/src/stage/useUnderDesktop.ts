import { type RefObject, useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { holdStream, KEEP_MS, type LiveStream } from "./live-stream.ts";
import type { StageCanvasHandle } from "./stage-engine.ts";

// The desktop under the browser's window shows only its menu bar and margins. While the user merely
// watches it is a picture, refreshed this often, so the clock in that bar stays about right: nothing
// is decoded, or asked of the computer, between. In the user's hands it is live, as their pointer may
// reach it.
export const UNDER_REFRESH_MS = 30_000;
// How long a refresh stays open for a fresh picture: a key frame, then the sharper paint-over.
export const UNDER_AWAKE_MS = 1_500;

export function useUnderDesktop({
  api,
  cellId,
  canvas,
  listed,
  inSight,
  live,
}: {
  api: ApiClient;
  // The running desktop the browser is in front of, if it is.
  cellId: string | null;
  canvas: RefObject<StageCanvasHandle | null>;
  listed: RefObject<readonly string[]>;
  inSight: boolean;
  live: boolean;
}): void {
  const [stream, setStream] = useState<LiveStream | null>(null);
  const [awake, setAwake] = useState(true);
  const [wasOn, setWasOn] = useState(cellId);
  if (cellId !== wasOn) {
    setWasOn(cellId);
    setAwake(true);
  }

  useEffect(() => {
    if (!cellId) return;
    const held = holdStream({ api, cellId, surface: "desktop" }, () => listed.current);
    const disconnect = held.stream.connect((source) => {
      if (canvas.current) canvas.current.attachUnder(source);
      else source.stop();
    });
    setStream(held.stream);
    let shown = false;
    let openedAt = Date.now();
    let closing: ReturnType<typeof setTimeout> | undefined;
    const offStats = canvas.current?.onUnderStats(({ presented }) => {
      held.stream.presented(presented);
      if (shown) return;
      shown = true;
      closing = setTimeout(
        () => setAwake(false),
        Math.max(0, UNDER_AWAKE_MS - (Date.now() - openedAt)),
      );
    });
    const refresh = setInterval(() => {
      shown = false;
      openedAt = Date.now();
      setAwake(true);
    }, UNDER_REFRESH_MS);
    return () => {
      clearInterval(refresh);
      clearTimeout(closing);
      offStats?.();
      disconnect();
      canvas.current?.detachUnder();
      setStream(null);
      held.release(KEEP_MS);
    };
  }, [api, canvas, cellId, listed]);

  useEffect(() => {
    stream?.show(inSight && (live || awake));
  }, [stream, inSight, live, awake]);
}
