import { Input, MP4, UrlSource } from "mediabunny";
import type { ReplaySource } from "../stage/worker-protocol.ts";
import { RECORDING_CACHE_BYTES, recordingUrl, replayRequestInit } from "./recording-source.ts";

// A recording's video, read as it is needed. Apart from the plain helpers in recording-source.ts, so
// only what decodes video loads the decoder.
class RecordingHttpError extends Error {
  constructor(readonly status: number) {
    super(`Recording request failed (${status}).`);
  }
}

export function openRecording(source: ReplaySource): Input {
  return new Input({
    formats: [MP4],
    source: new UrlSource(recordingUrl(source), {
      requestInit: replayRequestInit(source),
      maxCacheSize: RECORDING_CACHE_BYTES,
      parallelism: 2,
      fetchFn: async (url, init) => {
        const response = await fetch(url, init);
        if (!response.ok) {
          await response.body?.cancel();
          throw new RecordingHttpError(response.status);
        }
        return response;
      },
      getRetryDelay: (attempts, error) => {
        if (error instanceof RecordingHttpError && error.status >= 400 && error.status < 500)
          return null;
        return attempts < 3 ? 0.5 * 2 ** attempts : null;
      },
    }),
  });
}
