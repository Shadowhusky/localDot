import workletUrl from "./capture-worklet.ts?worker&url";
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

export interface Capture {
  level(): number;
  // A complete, decodable PCM snapshot while capture continues; no MediaRecorder fragments.
  snapshot(): Promise<Float32Array>;
  audio(): Promise<Float32Array>;
  close(): void;
}

interface AudioSession {
  type: string;
}

// Only one owner per page, including a permission prompt still awaiting the user.
let releasePrevious: (() => void) | undefined;
const MAX_SAMPLES = SPEECH_RATE * 120;

export async function openCapture(record: boolean, signal?: AbortSignal): Promise<Capture> {
  if (signal?.aborted) throw new VoiceError("failed");
  if (!navigator.mediaDevices?.getUserMedia) throw new VoiceError("no-mic");
  releasePrevious?.();
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worker: AudioWorkletNode | undefined;
  let gain: GainNode | undefined;
  let closed = false;
  let stage = "audio setup";
  let total = 0;
  let serial = 0;
  let startupTimer = 0;
  let cancelStartup: (() => void) | undefined;
  const chunks: Float32Array[] = [];
  const pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: number }>();
  const session = (navigator as Navigator & { audioSession?: AudioSession }).audioSession;
  const previousType = session?.type;
  const close = () => {
    if (closed) return;
    closed = true;
    window.clearTimeout(startupTimer);
    cancelStartup?.();
    signal?.removeEventListener("abort", close);
    window.removeEventListener("pagehide", close);
    for (const request of pending.values()) {
      window.clearTimeout(request.timer);
      request.reject(new VoiceError("failed"));
    }
    pending.clear();
    source?.disconnect();
    worker?.disconnect();
    worker?.port.close();
    gain?.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    void context?.close().catch(() => {});
    chunks.length = 0;
    if (releasePrevious === close) {
      releasePrevious = undefined;
      if (session && previousType && session.type === "play-and-record") {
        try {
          session.type = previousType;
        } catch {
          // Some WebKit versions expose a read-only session.
        }
      }
    }
  };
  releasePrevious = close;
  signal?.addEventListener("abort", close, { once: true });
  window.addEventListener("pagehide", close);
  try {
    if (session) {
      try {
        session.type = "play-and-record";
      } catch {
        // Capture still works where Audio Session is unavailable.
      }
    }
    // Resume in the click gesture, before waiting for microphone permission. On iOS doing
    // this after getUserMedia can leave the next audio graph suspended indefinitely.
    stage = "audio context";
    context = new AudioContext();
    const ready = new Promise<void>((resolve, reject) => {
      cancelStartup = () => reject(new VoiceError("failed"));
      startupTimer = window.setTimeout(() => reject(new VoiceError("no-mic")), 8000);
      void context?.resume().then(resolve, reject);
    }).finally(() => {
      window.clearTimeout(startupTimer);
      cancelStartup = undefined;
    });
    // Attach rejection handlers now, while the permission prompt may still be open.
    void ready.catch(() => {});
    const microphone = navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    stage = "microphone permission";
    stream = await microphone;
    if (closed) {
      for (const track of stream.getTracks()) track.stop();
      throw new VoiceError("failed");
    }
    stage = "audio context resume";
    await ready;
    if (closed) throw new VoiceError("failed");
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const frame = new Float32Array(analyser.fftSize);
    source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    if (record) {
      stage = "capture worklet";
      await context.audioWorklet.addModule(workletUrl);
      if (closed) throw new VoiceError("failed");
      worker = new AudioWorkletNode(context, "localdot-speech-capture", {
        channelCount: 1,
        channelCountMode: "explicit",
      });
      worker.port.onmessage = (
        event: MessageEvent<{ samples?: Float32Array; flushed?: number }>,
      ) => {
        if (closed) return;
        if (event.data.samples && total < MAX_SAMPLES) {
          const samples = event.data.samples.subarray(0, MAX_SAMPLES - total);
          chunks.push(samples);
          total += samples.length;
        }
        if (event.data.flushed !== undefined) {
          const request = pending.get(event.data.flushed);
          if (!request) return;
          window.clearTimeout(request.timer);
          pending.delete(event.data.flushed);
          request.resolve();
        }
      };
      // A connected, silent output keeps WebKit processing the capture graph without echo.
      gain = context.createGain();
      gain.gain.value = 0;
      source.connect(worker);
      worker.connect(gain).connect(context.destination);
    }
    const snapshot = async () => {
      if (closed || !worker) throw new VoiceError("failed");
      if (stream?.getTracks().some((track) => track.muted || track.readyState === "ended"))
        throw new VoiceError("no-mic");
      const id = ++serial;
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new VoiceError("no-mic"));
        }, 2000);
        pending.set(id, { resolve, reject, timer });
        worker?.port.postMessage({ flush: id });
      });
      const samples = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      return samples;
    };
    return {
      level() {
        if (closed || context?.state !== "running") return -1;
        analyser.getFloatTimeDomainData(frame);
        return loudness(frame);
      },
      snapshot,
      async audio() {
        try {
          return await snapshot();
        } finally {
          close();
        }
      },
      close,
    };
  } catch (error) {
    if (!closed)
      console.warn("Voice capture failed", stage, error instanceof Error ? error.name : "unknown");
    close();
    throw error instanceof VoiceError ? error : new VoiceError(captureFailure(error));
  }
}
