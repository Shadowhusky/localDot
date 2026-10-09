// How a tap's frames reach the render worker, fastest first. Chromium reads the track on the page
// and transfers the stream ("stream"). Safari reads tracks only in workers, so it transfers a clone
// of the track and the worker reads it ("track"). Where that fails, each frame the client's video
// presents is copied on the page and posted on its own ("presented"), which iOS ran at about 4 fps.
export type FramePath = "stream" | "track" | "presented";

export interface FrameSource {
  readable?: ReadableStream<VideoFrame>;
  // A clone of the client's track, for a render worker that reads its frames itself. The worker
  // owns it once handed over, and the source no longer holds it.
  track?: MediaStreamTrack;
  frames?: (deliver: (frame: VideoFrame) => void) => void;
  trackId: string;
  first?: VideoFrame;
  // Frames copied so far, where they pass the page (the presented path).
  delivered?: () => number;
  // Ends the tap and releases a seed frame that was never handed on.
  stop(): void;
}

// `workerTracks`: the render worker reads tracks (null while it has not said).
export function framePath(source: FrameSource, workerTracks: boolean | null): FramePath | null {
  if (source.readable) return "stream";
  if (source.track && workerTracks) return "track";
  if (source.frames) return "presented";
  return null;
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
// `tracks: false` leaves out the clone for the worker, once it proved to yield nothing here.
export function tapVideoTrack(
  video: VideoLike,
  { tracks = true }: { tracks?: boolean } = {},
): FrameSource | undefined {
  const stream = video.srcObject as StreamLike | null | undefined;
  if (!stream || typeof stream.getVideoTracks !== "function") return undefined;
  const track = stream.getVideoTracks()[0];
  if (!track) return undefined;
  if (typeof MediaStreamTrackProcessor === "undefined")
    return tapPresentedFrames(video, track, tracks);
  const clone = track.clone();
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

// Safari decodes into the client's <video> but has no MediaStreamTrackProcessor on the page. The
// source carries a clone of the track for the worker, and, should the worker not read it, copies
// each frame the video presents as it is shown. WebKit's video holds a stale picture of a track a
// worker writes (a still screen showed its first frame for good), so there is no seed: the stream
// asks for a key frame instead.
function tapPresentedFrames(
  video: VideoLike,
  track: MediaStreamTrack,
  tracks: boolean,
): FrameSource | undefined {
  const request = video.requestVideoFrameCallback?.bind(video);
  const clone = tracks && typeof track.clone === "function" ? track.clone() : undefined;
  if (!request && !clone) return undefined;
  let handle: number | undefined;
  let ended = false;
  let delivered = 0;
  const source: FrameSource = {
    trackId: track.id,
    track: clone,
    delivered: () => delivered,
    frames: request
      ? (deliver) => {
          const present = () => {
            handle = undefined;
            if (ended) return;
            try {
              deliver(new VideoFrame(video as unknown as HTMLVideoElement));
              delivered++;
            } catch {}
            handle = request(present);
          };
          if (!ended) handle = request(present);
        }
      : undefined,
    stop: () => {
      ended = true;
      source.track?.stop();
      if (handle !== undefined) video.cancelVideoFrameCallback?.(handle);
    },
  };
  return source;
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
