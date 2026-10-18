import { SpeechSamples } from "./pcm.ts";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class SpeechCapture extends AudioWorkletProcessor {
  readonly samples = new SpeechSamples(sampleRate, (samples) =>
    this.port.postMessage({ samples }, [samples.buffer]),
  );

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ flush: number }>) => {
      this.samples.flush();
      this.port.postMessage({ flushed: event.data.flush });
    };
  }

  process(inputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    if (input) this.samples.push(input);
    return true;
  }
}

registerProcessor("localdot-speech-capture", SpeechCapture);
