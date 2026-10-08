// Chromium taps frames on the page. Safari has no MediaStreamTrackProcessor there, but has one in
// workers and can transfer a track to one, so its source is the track itself.
export interface FrameSource {
  readable?: ReadableStream<VideoFrame>;
  track?: MediaStreamTrack;
  trackId: string;
  first?: VideoFrame;
  // Ends the tap and releases a seed frame that was never handed on.
  stop(): void;
}

export function frameTapSupport(): { ok: true } | { ok: false; reason: string } {
  if (typeof VideoFrame === "undefined" || typeof OffscreenCanvas === "undefined") {
    return {
      ok: false,
      reason: "This browser lacks WebCodecs. Open localDot in a current Chromium browser.",
    };
  }
  if (typeof MediaStreamTrackProcessor === "undefined" && typeof MediaStreamTrack === "undefined") {
    return {
      ok: false,
      reason:
        "This browser can't show the live desktop. Update Safari, or open localDot in Chrome.",
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
  if (typeof MediaStreamTrackProcessor === "undefined") {
    const first = currentFrame(video);
    return {
      track: clone,
      trackId: track.id,
      first,
      stop: () => {
        first?.close();
        // Once transferred, the worker owns the clone and stops it.
        try {
          clone.stop();
        } catch {}
      },
    };
  }
  const processor = new MediaStreamTrackProcessor({
    track: clone as MediaStreamTrack & MediaStreamVideoTrack,
  });
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
