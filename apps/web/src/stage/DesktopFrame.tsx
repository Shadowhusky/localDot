import { useEffect, useRef } from "react";
import { type FrameSource, tapVideoTrack } from "./frame-source.ts";

export interface DesktopFrameProps {
  src: string;
  onSource(source: FrameSource): void;
  // The client has shown no video element for STALE_MS: its page is an error, or it never loaded.
  onStale(): void;
  // A live decoder must not leave the stage on an obsolete tap after a browser suspension.
  lastPresentedAt?(): number;
}

interface FrameVideo {
  tagName?: string;
  srcObject: unknown;
  readyState?: number;
  getVideoPlaybackQuality?(): { totalVideoFrames: number };
}

const POLL_MS = 250;
export const STALE_MS = 10_000;

// Hosts Selkies' client out of sight and hands its video track to the stage. Polling is the only
// signal: the client swaps its track on every (re)connect without an event the parent can hear.
// Everything read from the iframe is checked by shape: its objects are not instances of this
// realm's HTMLVideoElement or MediaStream. A new src remounts this component (its key), so the
// poll starts afresh with each client.
export function DesktopFrame({ src, onSource, onStale, lastPresentedAt }: DesktopFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let tapped: string | null = null;
    let seenAt = Date.now();
    let polledAt = seenAt;
    let decodedFrames = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      const suspended = now - polledAt >= STALE_MS;
      polledAt = now;
      // CDP and some browser suspensions stop timers without dispatching lifecycle events.
      // Their old transferred frame stream can remain stalled after JavaScript resumes.
      if (suspended) {
        seenAt = now;
        onStale();
        return;
      }
      const doc = frameRef.current?.contentDocument;
      const video = doc?.getElementById("videoStream") as FrameVideo | null | undefined;
      if (video?.tagName !== "VIDEO") {
        if (Date.now() - seenAt >= STALE_MS) {
          seenAt = Date.now();
          onStale();
        }
        return;
      }
      seenAt = Date.now();
      const decoded = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      const presentedAt = lastPresentedAt?.() ?? 0;
      if (decoded > decodedFrames && presentedAt > 0 && Date.now() - presentedAt >= STALE_MS) {
        decodedFrames = decoded;
        onStale();
        return;
      }
      decodedFrames = decoded;
      const stream = video.srcObject as
        | { getVideoTracks?: () => { id: string }[] }
        | null
        | undefined;
      const track =
        typeof stream?.getVideoTracks === "function" ? stream.getVideoTracks()[0] : undefined;
      if (!track || track.id === tapped) return;
      // The element itself: the seed frame is copied from it.
      const source = tapVideoTrack(video);
      if (!source) return;
      tapped = source.trackId;
      onSource(source);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [onSource, onStale, lastPresentedAt]);

  return (
    <iframe
      ref={frameRef}
      className="desktop-frame"
      src={src}
      title="Desktop stream client"
      inert
    />
  );
}
