export interface FrameSource {
  readable: ReadableStream<VideoFrame>;
  trackId: string;
  first?: VideoFrame;
  // Ends the tap and releases a seed frame that was never handed on.
  stop(): void;
}

export function frameTapSupport(): { ok: true } | { ok: false; reason: string } {
  if (typeof MediaStreamTrackProcessor === "undefined") {
    return {
      ok: false,
      reason:
        "This browser has no MediaStreamTrackProcessor. Open localDot in Google Chrome or another Chromium browser.",
    };
  }
  if (typeof VideoFrame === "undefined" || typeof OffscreenCanvas === "undefined") {
    return {
      ok: false,
      reason: "This browser lacks WebCodecs. Open localDot in a current Chromium browser.",
    };
  }
  return { ok: true };
}

interface VideoLike {
  srcObject: unknown;
  readyState?: number;
}

interface StreamLike {
  getVideoTracks?: () => MediaStreamTrack[];
}

// A clone of the client's track sees every decoded frame (S1); the client's own <video> keeps the
// original, so the stage never interferes with Selkies' pipeline. The video lives in the iframe's
// realm, where `MediaStream` is a different constructor, so the stream is recognised by shape.
// The clone sees only frames decoded after it exists, so the source also carries the frame the
// video shows now, taken after the clone so that none falls between the two (S8).
export function tapVideoTrack(video: VideoLike): FrameSource | undefined {
  const stream = video.srcObject as StreamLike | null | undefined;
  if (!stream || typeof stream.getVideoTracks !== "function") return undefined;
  const track = stream.getVideoTracks()[0];
  if (!track) return undefined;
  const clone = track.clone();
  const processor = new MediaStreamTrackProcessor({ track: clone });
  const first = currentFrame(video);
  return {
    readable: processor.readable,
    trackId: track.id,
    first,
    stop: () => {
      first?.close();
      clone.stop();
    },
  };
}

// HAVE_CURRENT_DATA: the video has a frame to copy. The copy works across realms.
function currentFrame(video: VideoLike): VideoFrame | undefined {
  if ((video.readyState ?? 0) < 2) return undefined;
  try {
    return new VideoFrame(video as unknown as HTMLVideoElement);
  } catch {
    return undefined;
  }
}
