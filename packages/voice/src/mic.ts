import { downsample, float32ToInt16 } from "./pcm.ts";
import { MIC_SAMPLE_RATE } from "./wire.ts";

export type MicProblem = "denied" | "no_device" | "unavailable";

export const MIC_MESSAGES: Record<MicProblem, string> = {
  denied:
    "Microphone access is blocked. Allow it for this page in the browser's site settings (the icon left of the address), then turn Voice input on again. Typing still works.",
  no_device:
    "No microphone was found. Connect one, then turn Voice input on again. Typing still works.",
  unavailable:
    "The microphone could not be opened. Close other apps using it, then turn Voice input on again. Typing still works.",
};

// 30 ms at 16 kHz: small enough that speech reaches the endpointer without delay.
export const FRAME_SAMPLES = 480;

export function micProblem(error: unknown): MicProblem {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no_device";
  return "unavailable";
}

export class FrameBatcher {
  readonly #onFrame: (pcm: Int16Array<ArrayBuffer>) => void;
  readonly #frame = new Float32Array(FRAME_SAMPLES);
  #filled = 0;

  constructor(onFrame: (pcm: Int16Array<ArrayBuffer>) => void) {
    this.#onFrame = onFrame;
  }

  push(samples: Float32Array): void {
    for (const sample of samples) {
      this.#frame[this.#filled++] = sample;
      if (this.#filled === FRAME_SAMPLES) {
        this.#onFrame(float32ToInt16(this.#frame));
        this.#filled = 0;
      }
    }
  }
}

const WORKLET = `class LocaldotMic extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("localdot-mic", LocaldotMic);`;

export interface Mic {
  close(): void;
}

export type MicResult =
  | { ok: true; mic: Mic }
  | { ok: false; problem: MicProblem; message: string };

export interface MicDeps {
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  createContext?: () => AudioContext;
}

function contextAt16k(): AudioContext {
  try {
    return new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
  } catch {
    return new AudioContext();
  }
}

export async function openMic(
  onFrame: (pcm: Int16Array<ArrayBuffer>) => void,
  deps: MicDeps = { mediaDevices: globalThis.navigator?.mediaDevices },
): Promise<MicResult> {
  const fail = (problem: MicProblem): MicResult => ({
    ok: false,
    problem,
    message: MIC_MESSAGES[problem],
  });
  if (!deps.mediaDevices?.getUserMedia) return fail("unavailable");
  let stream: MediaStream;
  try {
    stream = await deps.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    return fail(micProblem(error));
  }
  const ctx = (deps.createContext ?? contextAt16k)();
  try {
    await ctx.resume();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "localdot-mic");
    const batcher = new FrameBatcher(onFrame);
    const rate = ctx.sampleRate;
    node.port.onmessage = (event: MessageEvent<Float32Array>) =>
      batcher.push(
        rate === MIC_SAMPLE_RATE ? event.data : downsample(event.data, rate, MIC_SAMPLE_RATE),
      );
    source.connect(node);
    // The worklet writes nothing, but it only runs while connected to the destination.
    node.connect(ctx.destination);
    return {
      ok: true,
      mic: {
        close: () => {
          node.port.onmessage = null;
          node.disconnect();
          source.disconnect();
          for (const track of stream.getTracks()) track.stop();
          void ctx.close();
        },
      },
    };
  } catch {
    for (const track of stream.getTracks()) track.stop();
    void ctx.close();
    return fail("unavailable");
  }
}
