import { loudness, SPEECH_RATE } from "./wav.ts";

export type VoiceFailure =
  | "denied"
  | "no-mic"
  | "no-speech"
  | "unavailable"
  | "network"
  | "busy"
  | "failed";

export class VoiceError extends Error {
  constructor(readonly failure: VoiceFailure) {
    super(failure);
    this.name = "VoiceError";
  }
}

export function captureFailure(error: unknown): VoiceFailure {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError")
    return "no-mic";
  return "failed";
}

// The microphone while the user talks: how loud it is now for the waveform, and, when the words are
// turned into text on the computer, the recording, kept in memory only.
export interface Capture {
  // 0 to 1, or −1 while the browser won't let the page measure sound yet.
  level(): number;
  // Stops recording and hands over the audio at 16 kHz, mono.
  audio(): Promise<Float32Array>;
  close(): void;
}

export async function openCapture(record: boolean): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia) throw new VoiceError("no-mic");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw new VoiceError(captureFailure(error));
  }
  const context = new AudioContext();
  void context.resume().catch(() => {});
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const frame = new Float32Array(analyser.fftSize);
  const recorder = record ? new MediaRecorder(stream) : null;
  const chunks: Blob[] = [];
  recorder?.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder?.start();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (recorder?.state === "recording") recorder.stop();
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => {});
  };
  return {
    level() {
      if (closed || context.state !== "running") return -1;
      analyser.getFloatTimeDomainData(frame);
      return loudness(frame);
    },
    async audio() {
      if (!recorder) throw new VoiceError("failed");
      if (recorder.state === "recording") {
        const stopped = new Promise((resolve) =>
          recorder.addEventListener("stop", resolve, { once: true }),
        );
        recorder.stop();
        await stopped;
      }
      close();
      const recorded = new Blob(chunks, { type: recorder.mimeType });
      if (!recorded.size) return new Float32Array();
      // Decoding into a 16 kHz context resamples on the way, without a running audio graph.
      const decoded = await new OfflineAudioContext(1, 1, SPEECH_RATE).decodeAudioData(
        await recorded.arrayBuffer(),
      );
      return decoded.getChannelData(0);
    },
    close,
  };
}
