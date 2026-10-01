import { useEffect, useRef } from "react";
import { type FrameSource, tapVideoTrack } from "./frame-source.ts";

export interface DesktopFrameProps {
  src: string;
  onSource(source: FrameSource): void;
  // The client has shown no video element for STALE_MS: its page is an error, or it never loaded.
  onStale(): void;
}

interface FrameVideo {
  tagName?: string;
  srcObject: unknown;
  readyState?: number;
}

const POLL_MS = 250;
export const STALE_MS = 10_000;

// Hosts Selkies' client out of sight and hands its video track to the stage. Polling is the only
// signal: the client swaps its track on every (re)connect without an event the parent can hear.
// Everything read from the iframe is checked by shape: its objects are not instances of this
// realm's HTMLVideoElement or MediaStream. A new src remounts this component (its key), so the
// poll starts afresh with each client.
export function DesktopFrame({ src, onSource, onStale }: DesktopFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let tapped: string | null = null;
    let seenAt = Date.now();
    const timer = setInterval(() => {
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
  }, [onSource, onStale]);

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
