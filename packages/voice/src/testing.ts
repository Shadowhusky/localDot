import type { SpeechTrack } from "@localdot/avatar";
import type { PlaybackContext, SpeechSink } from "./player.ts";

export class FakeSource {
  buffer: { getChannelData(channel: number): Float32Array } | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  connected = true;
  connect(): void {}
  disconnect(): void {
    this.connected = false;
  }
  start(at: number): void {
    this.startedAt = at;
  }
  stop(at = 0): void {
    this.stoppedAt = at;
  }
  get stopped(): boolean {
    return this.stoppedAt !== null;
  }
}

// A GainNode stand-in that records its automation as [kind, value, time].
export class FakeGain {
  readonly automation: ["set" | "ramp", number, number][] = [];
  readonly gain = {
    value: 1,
    setValueAtTime: (value: number, at: number) => {
      this.automation.push(["set", value, at]);
    },
    linearRampToValueAtTime: (value: number, at: number) => {
      this.automation.push(["ramp", value, at]);
    },
  };
  connected = true;
  connect(): void {}
  disconnect(): void {
    this.connected = false;
  }
}

// An AudioContext stand-in: the test moves currentTime; output runs 50 ms behind, and context time
// 0 is performance time 5000.
export class FakeAudioContext {
  currentTime = 10;
  state: AudioContextState = "running";
  readonly destination = {};
  readonly outputLatency = 0.05;
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  readonly #stateListeners: (() => void)[] = [];
  resume(): Promise<void> {
    this.state = "running";
    for (const listener of this.#stateListeners) listener();
    return Promise.resolve();
  }
  addEventListener(_type: "statechange", listener: () => void): void {
    this.#stateListeners.push(listener);
  }
  getOutputTimestamp() {
    return {
      contextTime: this.currentTime - 0.05,
      performanceTime: 5000 + this.currentTime * 1000,
    };
  }
  asPlayback(): PlaybackContext {
    return this as unknown as PlaybackContext;
  }
}

export class RecordingSink implements SpeechSink {
  readonly tracks: (SpeechTrack | null)[] = [];
  speak(track: SpeechTrack | null): void {
    this.tracks.push(track);
  }
  get last(): SpeechTrack | null | undefined {
    return this.tracks.at(-1);
  }
}

// A tone whose RMS is `rms` for `seconds`, as 24 kHz int16 PCM.
export function tone(seconds: number, rms: number): Int16Array {
  const n = Math.round(seconds * 24_000);
  const out = new Int16Array(n);
  const amplitude = rms * Math.SQRT2;
  for (let i = 0; i < n; i++)
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / 24_000) * 32767);
  return out;
}

// A browser WebSocket stand-in that a test opens, feeds and closes by hand. A browser reports a close
// later; with `lateClose`, close() only starts closing and the test calls closed() when it lands.
export class FakeSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  lateClose = false;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: (string | Uint8Array)[] = [];
  readonly url: string;
  readonly protocols: string[];
  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 2;
    if (!this.lateClose) this.closed();
  }
  closed(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  receive(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

export function socketFactory(options: { lateClose?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const create = (url: string, protocols: string[]) => {
    const socket = new FakeSocket(url, protocols);
    socket.lateClose = options.lateClose ?? false;
    sockets.push(socket);
    return socket;
  };
  return { sockets, create };
}
