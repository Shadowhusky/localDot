export interface FrameSource {
  readable: ReadableStream<VideoFrame>;
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
  if (typeof MediaStreamTrackProcessor === "undefined" && !reportsVideoFrames()) {
    return {
      ok: false,
      reason:
        "This browser can't show the live desktop. Update Safari, or open localDot in Chrome.",
    };
  }
  return { ok: true };
}

function reportsVideoFrames(): boolean {
  return (
    typeof HTMLVideoElement !== "undefined" &&
    typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function"
  );
}

interface VideoLike {
  srcObject: unknown;
  readyState?: number;
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
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
  if (typeof MediaStreamTrackProcessor === "undefined") return tapPresentedFrames(video, track.id);
  const clone = track.clone();
  const processor = new MediaStreamTrackProcessor({ track: clone as MediaStreamTrack & MediaStreamVideoTrack });
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

// Safari decodes into the client's <video> but has no MediaStreamTrackProcessor on the page, so
// each frame the video presents is copied. A one-frame queue keeps the stage current: a frame
// that would wait behind the worker is never made, so no GPU memory piles up.
function tapPresentedFrames(video: VideoLike, trackId: string): FrameSource | undefined {
  const request = video.requestVideoFrameCallback?.bind(video);
  if (!request) return undefined;
  let handle: number | undefined;
  let ended = false;
  let controller!: ReadableStreamDefaultController<VideoFrame>;
  const present = () => {
    handle = undefined;
    if (ended) return;
    if ((controller.desiredSize ?? 0) > 0) {
      try {
        controller.enqueue(new VideoFrame(video as unknown as HTMLVideoElement));
      } catch {}
    }
    handle = request(present);
  };
  const end = () => {
    if (ended) return;
    ended = true;
    if (handle !== undefined) video.cancelVideoFrameCallback?.(handle);
    try {
      controller.close();
    } catch {}
  };
  const readable = new ReadableStream<VideoFrame>(
    {
      start(c) {
        controller = c;
        handle = request(present);
      },
      cancel: end,
    },
    new CountQueuingStrategy({ highWaterMark: 1 }),
  );
  const first = currentFrame(video);
  return {
    readable,
    trackId,
    first,
    stop: () => {
      first?.close();
      end();
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
