### Task 9: optional voice input in the browser — microphone, listener, `/voice/stt`, barge-in

**Files:**
- Create: `packages/voice/src/{mic,listener}.ts`, `packages/voice/src/host/stt-relay.ts`
- Modify: `packages/voice/src/index.ts`, `packages/voice/src/host/{index,dev-plugin,fake-voiced}.ts`, `apps/avatar-harness/index.html` (Voice input section), `apps/avatar-harness/src/voice.ts` (input, barge-in, hooks), `apps/avatar-harness/scripts/capture.mjs` (`--chrome-flag`)
- Test: `packages/voice/src/{mic,listener}.test.ts`, `packages/voice/src/host/stt-relay.test.ts`

**Interfaces:**
- Consumes: Task 4's `VoiceSocket`, `SocketFactory`, `parseSttServerMessage`, `SttMode`, `SttErrorCode`, `downsample`, `float32ToInt16`, `MIC_SAMPLE_RATE`, `Speaker`, `VoicePlayer`; Task 5's `attachVoiceGateway` (`stt` option), `VoicedEndpoint`, `PROTOCOL`; Task 6's harness `voice.ts`; voiced's `/stt` (Task 7).
- Produces:
  - `mic.ts`: `MicProblem = "denied" | "no_device" | "unavailable"`, `MIC_MESSAGES`, `FRAME_SAMPLES = 480` (30 ms at 16 kHz), `micProblem(error)`, `FrameBatcher(onFrame).push(samples)`, `Mic {close()}`, `MicResult`, `MicDeps {mediaDevices?, createContext?}`, `openMic(onFrame, deps?) -> Promise<MicResult>` (asks for echo cancellation, noise suppression and AGC; a 16 kHz AudioContext, or averaging down from the device rate).
  - `listener.ts`: `ListenerEvents {ready?, speechStarted?, partial?, final?, utterance?, error?, status?}`, `ListenerOptions {create?, token?, gate?}`, `Listener(url, events, options?)` with `open()`, `listen(mode) -> boolean`, `frame(pcm)`, `release()`, `close()`. An `end` with text becomes `utterance(text, lang)` — the message to send like a typed one.
  - `host/stt-relay.ts`: `MAX_HELD_BYTES = 320_000`, `relaySpeechInput(browser, endpoint)`.
  - Harness: a Voice input switch (off by default) with Push to talk / Hands-free, a hold-to-talk button and the right Option key, "Pause listening while she speaks" (half duplex), and `window.__voice` additions `voiceInput(mode)`, `talk(ms)`, `stats().bargeInMs`, `stats().utterances`. Turning input on resolves once `/voice/stt` is open (at most 5 s); in push-to-talk, microphone audio leaves the page only while the key is held; a press while the socket reconnects says so instead of failing silently.
  - `capture.mjs --chrome-flag=<flag>` (repeatable).

- [ ] **Step 1: Write the failing tests**

`packages/voice/src/mic.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { FRAME_SAMPLES, FrameBatcher, MIC_MESSAGES, micProblem, openMic } from "./mic.ts";

describe("micProblem", () => {
  it("names a refusal, a missing microphone and anything else", () => {
    expect(micProblem(new DOMException("denied", "NotAllowedError"))).toBe("denied");
    expect(micProblem(new DOMException("insecure", "SecurityError"))).toBe("denied");
    expect(micProblem(new DOMException("none", "NotFoundError"))).toBe("no_device");
    expect(micProblem(new DOMException("busy", "NotReadableError"))).toBe("unavailable");
    expect(micProblem("weird")).toBe("unavailable");
  });
});

describe("openMic", () => {
  it("explains how to allow the microphone when permission is denied", async () => {
    const mediaDevices = {
      getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
    };
    expect(await openMic(() => {}, { mediaDevices })).toEqual({
      ok: false,
      problem: "denied",
      message: MIC_MESSAGES.denied,
    });
    expect(MIC_MESSAGES.denied).toMatch(/site settings/);
    expect(MIC_MESSAGES.denied).toMatch(/Typing still works/);
  });

  it("asks for echo cancellation so her own voice does not count as the user's", async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("none", "NotFoundError")));
    expect(await openMic(() => {}, { mediaDevices: { getUserMedia } })).toMatchObject({
      problem: "no_device",
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  });

  it("reports a browser without microphone access as unavailable", async () => {
    expect(await openMic(() => {}, {})).toMatchObject({ ok: false, problem: "unavailable" });
  });
});

describe("FrameBatcher", () => {
  it("turns worklet blocks into 30 ms int16 frames", () => {
    const frames: Int16Array[] = [];
    const batcher = new FrameBatcher((pcm) => frames.push(pcm));
    for (let i = 0; i < 4; i++) batcher.push(new Float32Array(128).fill(0.5));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(FRAME_SAMPLES);
    expect(frames[0]?.[0]).toBe(16384);
  });
});
```

`packages/voice/src/listener.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { Listener } from "./listener.ts";
import { socketFactory } from "./testing.ts";

const setup = (gate?: () => boolean) => {
  const { sockets, create } = socketFactory();
  const heard: string[] = [];
  const listener = new Listener(
    "ws://127.0.0.1:4753/voice/stt",
    {
      ready: () => heard.push("ready"),
      speechStarted: () => heard.push("speech"),
      partial: (t) => heard.push(`partial:${t}`),
      final: (t, lang) => heard.push(`final:${t}:${lang}`),
      utterance: (t, lang) => heard.push(`utterance:${t}:${lang}`),
      error: (code) => heard.push(`error:${code}`),
    },
    { create, ...(gate ? { gate } : {}) },
  );
  listener.open();
  sockets[0]?.open();
  return { socket: sockets[0], heard, listener };
};

describe("Listener", () => {
  it("asks to listen, streams frames as bytes and releases", () => {
    const { socket, listener } = setup();
    listener.listen("ptt");
    listener.frame(new Int16Array([1, -1]));
    listener.release();
    const [listen, audio, release] = socket?.sent ?? [];
    expect(listen).toBe('{"type":"listen","mode":"ptt"}');
    expect(Array.from(audio as Uint8Array)).toEqual([1, 0, 255, 255]);
    expect(release).toBe('{"type":"release"}');
  });

  it("reports speech, partial and final text, and sends a finished utterance on", () => {
    const { socket, heard } = setup();
    for (const message of [
      { type: "ready" },
      { type: "speech_started", utterance: 1 },
      { type: "partial", utterance: 1, text: "我在" },
      { type: "final", utterance: 1, text: "我在。", lang: "zh" },
      { type: "end", utterance: 1, text: "我在。", lang: "zh" },
      { type: "end", utterance: 2, text: "  ", lang: null },
      { type: "error", code: "unavailable", message: "refused" },
    ]) {
      socket?.receive(JSON.stringify(message));
    }
    expect(heard).toEqual([
      "ready",
      "speech",
      "partial:我在",
      "final:我在。:zh",
      "utterance:我在。:zh",
      "error:unavailable",
    ]);
  });

  it("holds frames back while its gate is shut", () => {
    let open = false;
    const { socket, listener } = setup(() => open);
    listener.frame(new Int16Array([1]));
    open = true;
    listener.frame(new Int16Array([2]));
    expect(socket?.sent.map((m) => [...(m as Uint8Array)])).toEqual([[2, 0]]);
  });
});
```

In `packages/voice/src/host/fake-voiced.ts`, inside the `connection` handler, add this line after the
token check's closing `}` and before the `ready` greeting:
```ts
    if (request.url === "/stt") return fakeStt(socket, received);
```
and append:
```ts

// voiced's /stt as far as the relay can tell: ready on listen, and the bytes it heard on release.
function fakeStt(socket: WebSocket, received: unknown[]): void {
  let bytes = 0;
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      bytes += (data as Buffer).length;
      return;
    }
    const message = JSON.parse(data.toString()) as { type: string };
    received.push(message);
    if (message.type === "listen") socket.send(JSON.stringify({ type: "ready" }));
    if (message.type === "release") {
      socket.send(
        JSON.stringify({ type: "end", utterance: 1, text: `${bytes} bytes`, lang: "en" }),
      );
    }
  });
}
```

`packages/voice/src/host/stt-relay.test.ts`:
```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startFakeVoiced } from "./fake-voiced.ts";
import { attachVoiceGateway } from "./gateway.ts";
import { relaySpeechInput } from "./stt-relay.ts";

const TOKEN = "v".repeat(43);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function gatewayTo(voicedHost: string | null) {
  const server: Server = createServer();
  const detach = attachVoiceGateway(server, {
    authorize: () => true,
    tts: () => ({ handle: () => {}, close: () => {} }),
    stt: (browser) =>
      relaySpeechInput(browser, async () =>
        voicedHost ? { host: voicedHost, token: TOKEN } : null,
      ),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        detach();
        server.close(() => resolve());
      }),
  );
  const page = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/voice/stt`, [
    "localdot.v1",
  ]);
  const messages: Record<string, unknown>[] = [];
  const closed = new Promise<void>((resolve) => page.once("close", () => resolve()));
  page.on("message", (data) => messages.push(JSON.parse(data.toString())));
  cleanups.push(() => page.terminate());
  await new Promise((resolve) => page.once("open", resolve));
  return { page, messages, closed };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe("relaySpeechInput", () => {
  it("pipes control messages and audio to voiced, holding what arrives before it connects", async () => {
    const voiced = await startFakeVoiced(TOKEN);
    cleanups.push(voiced.close);
    const { page, messages } = await gatewayTo(voiced.host);
    page.send(JSON.stringify({ type: "listen", mode: "ptt" }));
    page.send(new Uint8Array(960));
    page.send(new Uint8Array(960));
    page.send(JSON.stringify({ type: "release" }));
    await until(() => messages.length === 2);
    expect(messages).toEqual([
      { type: "ready" },
      { type: "end", utterance: 1, text: "1920 bytes", lang: "en" },
    ]);
  });

  it("tells the page voice input is unavailable when voiced is not running, then closes", async () => {
    const { messages, closed } = await gatewayTo(null);
    await closed;
    expect(messages).toEqual([
      { type: "error", code: "unavailable", message: "voiced is not running" },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd "/Volumes/Husky's SSD 4T/Projects/localdot-avatar" && pnpm exec vitest run packages/voice/src/mic.test.ts packages/voice/src/listener.test.ts packages/voice/src/host/stt-relay.test.ts`
Expected: FAIL — `Failed to resolve import "./mic.ts"`, `"./listener.ts"`, `"./stt-relay.ts"`.

- [ ] **Step 3: Implement**

`packages/voice/src/mic.ts`:
```ts
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
```

`packages/voice/src/listener.ts`:
```ts
import type { Lang } from "./lang.ts";
import { type SocketFactory, VoiceSocket } from "./socket.ts";
import { parseSttServerMessage, type SttErrorCode, type SttMode } from "./wire.ts";

export interface ListenerEvents {
  ready?(): void;
  speechStarted?(): void;
  partial?(text: string): void;
  final?(text: string, lang: Lang | null): void;
  utterance?(text: string, lang: Lang | null): void;
  error?(code: SttErrorCode, message: string): void;
  status?(online: boolean): void;
}

export interface ListenerOptions {
  create?: SocketFactory;
  token?: string;
  // Return false to keep a microphone frame back, e.g. while her voice plays in half duplex.
  gate?: () => boolean;
}

// Voice input over the /voice/stt route: frames out; speech start, partial and final text back.
export class Listener {
  readonly #socket: VoiceSocket;
  readonly #events: ListenerEvents;
  readonly #gate: () => boolean;

  constructor(url: string, events: ListenerEvents, options: ListenerOptions = {}) {
    this.#events = events;
    this.#gate = options.gate ?? (() => true);
    const socketOptions = {
      ...(options.create ? { create: options.create } : {}),
      ...(options.token ? { token: options.token } : {}),
    };
    this.#socket = new VoiceSocket(
      url,
      {
        text: (data) => this.#message(data),
        binary: () => {},
        status: (online) => events.status?.(online),
      },
      socketOptions,
    );
  }

  open(): void {
    this.#socket.connect();
  }

  listen(mode: SttMode): boolean {
    return this.#socket.send(JSON.stringify({ type: "listen", mode }));
  }

  frame(pcm: Int16Array<ArrayBuffer>): void {
    if (this.#gate()) this.#socket.send(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  }

  release(): void {
    this.#socket.send(JSON.stringify({ type: "release" }));
  }

  close(): void {
    this.#socket.close();
  }

  #message(data: string): void {
    const message = parseSttServerMessage(data);
    if (!message) return;
    switch (message.type) {
      case "ready":
        this.#events.ready?.();
        break;
      case "speech_started":
        this.#events.speechStarted?.();
        break;
      case "partial":
        this.#events.partial?.(message.text);
        break;
      case "final":
        this.#events.final?.(message.text, message.lang);
        break;
      case "end":
        if (message.text.trim()) this.#events.utterance?.(message.text, message.lang);
        break;
      case "error":
        this.#events.error?.(message.code, message.message);
        break;
    }
  }
}
```

`packages/voice/src/host/stt-relay.ts`:
```ts
import { type RawData, WebSocket } from "ws";
import { PROTOCOL } from "../socket.ts";
import type { VoicedEndpoint } from "./local.ts";

// About ten seconds of 16 kHz microphone audio held while voiced's socket opens.
export const MAX_HELD_BYTES = 320_000;

// The page's /voice/stt socket, piped to voiced's /stt with the token added.
export function relaySpeechInput(
  browser: WebSocket,
  endpoint: () => Promise<VoicedEndpoint | null>,
): void {
  const held: { data: RawData; isBinary: boolean }[] = [];
  let heldBytes = 0;
  let voiced: WebSocket | null = null;
  const refuse = (message: string) => {
    if (browser.readyState !== WebSocket.OPEN) return;
    browser.send(JSON.stringify({ type: "error", code: "unavailable", message }));
    browser.close();
  };
  browser.on("message", (data: RawData, isBinary: boolean) => {
    if (voiced?.readyState === WebSocket.OPEN) {
      voiced.send(data, { binary: isBinary });
      return;
    }
    const size = Buffer.isBuffer(data) ? data.length : 0;
    if (heldBytes + size > MAX_HELD_BYTES) return;
    heldBytes += size;
    held.push({ data, isBinary });
  });
  browser.on("close", () => voiced?.close());
  void endpoint().then(
    (found) => {
      if (!found) return refuse("voiced is not running");
      if (browser.readyState !== WebSocket.OPEN) return;
      const socket = new WebSocket(`ws://${found.host}/stt`, [PROTOCOL], {
        headers: { authorization: `Bearer ${found.token}` },
      });
      voiced = socket;
      socket.on("open", () => {
        for (const message of held.splice(0))
          socket.send(message.data, { binary: message.isBinary });
        heldBytes = 0;
      });
      socket.on("message", (data: RawData, isBinary: boolean) =>
        browser.send(data, { binary: isBinary }),
      );
      socket.on("close", () => browser.close());
      socket.on("error", (error) => refuse(error.message));
    },
    () => refuse("voiced is not running"),
  );
}
```

In `packages/voice/src/index.ts`, add `export * from "./listener.ts";` and `export * from "./mic.ts";`
after the `./lang.ts` line. In `packages/voice/src/host/index.ts`, add
`export * from "./stt-relay.ts";` after the `./settings.ts` line.

In `packages/voice/src/host/dev-plugin.ts`, add `import { relaySpeechInput } from "./stt-relay.ts";`
after the `./settings.ts` import, and in `attachVoiceGateway(http, { … })` add after the `tts` entry:
```ts
        stt: (browser) => {
          supervisor.start();
          relaySpeechInput(browser, endpoint);
        },
```

In `apps/avatar-harness/index.html`, add before `</style>`:
```css
#mic[data-held] { border-color: var(--xenon); color: var(--xenon); }
```
and insert after `<p id="voice-note" class="note" aria-live="polite"></p>`:
```html
    <h2>Voice input</h2>
    <label><input id="voice-input" type="checkbox"> Voice input</label>
    <p id="mic-note" class="note" role="status"></p>
    <div id="voice-input-panel" hidden>
      <div class="row">
        <label><input type="radio" name="voice-mode" value="ptt" checked> Push to talk</label>
        <label><input type="radio" name="voice-mode" value="handsfree"> Hands-free</label>
      </div>
      <div class="row"><button id="mic" type="button">Hold to talk (or right ⌥)</button></div>
      <label><input id="half-duplex" type="checkbox"> Pause listening while she speaks</label>
      <p id="heard" class="note" aria-live="polite"></p>
    </div>
```

Replace `apps/avatar-harness/src/voice.ts` with:
```ts
import type { AvatarController, SpeechTrack } from "@localdot/avatar";
import {
  decodeAudioFrame,
  Listener,
  type Mic,
  openMic,
  parseTtsServerMessage,
  Speaker,
  type SttMode,
  VoicePlayer,
  VoiceSocket,
} from "@localdot/voice";
import { type VoiceStatus, voiceNote } from "./voice-notes.ts";

export interface VoiceStats {
  firstAudioMs: number[];
  speaking: boolean;
  shapes: string[];
  bargeInMs: number[];
  utterances: { text: string; lang: string | null }[];
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// The harness's voice loop: typed text in, her voice and mouth out; optional voice input.
export function mountVoice(controller: AvatarController): void {
  const note = byId<HTMLElement>("voice-note");
  const sayText = byId<HTMLTextAreaElement>("say-text");
  const micNote = byId<HTMLElement>("mic-note");
  const heard = byId<HTMLElement>("heard");
  const panel = byId<HTMLElement>("voice-input-panel");
  const toggle = byId<HTMLInputElement>("voice-input");
  const micButton = byId<HTMLButtonElement>("mic");
  const halfDuplex = byId<HTMLInputElement>("half-duplex");
  const ctx = new AudioContext();
  let lastTrack: SpeechTrack | null = null;
  const player = new VoicePlayer(ctx, {
    speak: (track) => {
      if (track) lastTrack = track;
      controller.speak(track);
    },
  });
  const status: VoiceStatus = { online: false, voice: null, notice: null };
  const render = () => {
    note.textContent = voiceNote(status);
  };
  const sentAt = new Map<number, number>();
  const firstOfReply: number[] = [];
  const bargeInMs: number[] = [];
  const utterances: VoiceStats["utterances"] = [];
  let replyStarting = false;

  const speaker = new Speaker(player, (message) => tts.send(JSON.stringify(message)), {
    sentence: (id) => {
      sentAt.set(id, performance.now());
      if (replyStarting) firstOfReply.push(id);
      replyStarting = false;
    },
    voice: (kind) => {
      status.voice = kind;
      render();
    },
    notice: (code) => {
      status.notice = code;
      render();
    },
  });
  const tts = new VoiceSocket(`ws://${location.host}/voice/tts`, {
    text: (data) => {
      const message = parseTtsServerMessage(data);
      if (message) speaker.message(message);
    },
    binary: (bytes) => {
      const frame = decodeAudioFrame(bytes);
      if (frame) speaker.audio(frame);
    },
    status: (online) => {
      status.online = online;
      render();
    },
  });
  tts.connect();
  render();

  const say = (text: string) => {
    void player.unlock();
    replyStarting = true;
    speaker.say(text);
  };
  byId<HTMLFormElement>("say-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (sayText.value.trim()) say(sayText.value);
  });
  byId<HTMLButtonElement>("stop").addEventListener("click", () => speaker.stop());

  const bargeIn = () => {
    if (!player.speaking) return;
    const started = performance.now();
    speaker.stop();
    bargeInMs.push(
      performance.now() - started + (ctx.outputLatency || ctx.baseLatency || 0) * 1000,
    );
  };
  const mode = (): SttMode =>
    document.querySelector<HTMLInputElement>('input[name="voice-mode"]:checked')?.value ===
    "handsfree"
      ? "handsfree"
      : "ptt";
  let mic: Mic | null = null;
  let held = false;
  let inputOnline = false;
  let whenOnline: (() => void) | null = null;
  const listener = new Listener(
    `ws://${location.host}/voice/stt`,
    {
      status: (online) => {
        inputOnline = online;
        if (!online) return;
        whenOnline?.();
        if (mic && mode() === "handsfree") listener.listen("handsfree");
      },
      speechStarted: bargeIn,
      partial: (text) => {
        heard.textContent = text;
      },
      final: (text) => {
        heard.textContent = text;
      },
      utterance: (text, lang) => {
        heard.textContent = `You said: ${text}`;
        utterances.push({ text, lang });
      },
      error: (_code, message) => {
        heard.textContent = message;
      },
    },
    // Push-to-talk audio leaves the page only while the key is held.
    { gate: () => (held || mode() === "handsfree") && !(halfDuplex.checked && player.speaking) },
  );

  const voiceInput = async (on: boolean) => {
    micNote.textContent = "";
    if (!on) {
      mic?.close();
      mic = null;
      listener.close();
      panel.hidden = true;
      toggle.checked = false;
      return;
    }
    const opened = await openMic((pcm) => listener.frame(pcm));
    if (!opened.ok) {
      toggle.checked = false;
      micNote.textContent = opened.message;
      return;
    }
    mic = opened.mic;
    toggle.checked = true;
    panel.hidden = false;
    listener.open();
    if (!inputOnline)
      await new Promise<void>((resolve) => {
        whenOnline = resolve;
        setTimeout(resolve, 5000);
      });
    whenOnline = null;
  };
  toggle.addEventListener("change", () => void voiceInput(toggle.checked));
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="voice-mode"]')) {
    radio.addEventListener("change", () => {
      if (!mic) return;
      if (mode() === "handsfree") listener.listen("handsfree");
      else listener.release();
    });
  }

  const press = () => {
    if (!mic || mode() !== "ptt" || held) return;
    if (!listener.listen("ptt")) {
      heard.textContent = "Voice input is still connecting. Try again in a moment.";
      return;
    }
    held = true;
    bargeIn();
    micButton.dataset.held = "true";
  };
  const release = () => {
    if (!held) return;
    held = false;
    listener.release();
    delete micButton.dataset.held;
  };
  micButton.addEventListener("pointerdown", press);
  micButton.addEventListener("pointerup", release);
  micButton.addEventListener("pointerleave", release);
  // Hold the right Option key to talk; it types nothing on its own.
  addEventListener("keydown", (event) => {
    if (event.code === "AltRight" && !event.repeat) press();
  });
  addEventListener("keyup", (event) => {
    if (event.code === "AltRight") release();
  });

  const stats = (): VoiceStats => ({
    firstAudioMs: firstOfReply.flatMap((id) => {
      const heardAt = player.firstAudioAt(id);
      const sent = sentAt.get(id);
      return heardAt !== undefined && sent !== undefined ? [heardAt - sent] : [];
    }),
    speaking: player.speaking,
    shapes: [...new Set(lastTrack?.visemes.map((v) => v.shape) ?? [])].sort(),
    bargeInMs: [...bargeInMs],
    utterances: [...utterances],
  });
  Object.assign(window, {
    __voice: {
      say,
      stop: () => speaker.stop(),
      online: () => status.online,
      stats,
      talk: async (ms: number) => {
        press();
        await new Promise((resolve) => setTimeout(resolve, ms));
        release();
      },
      voiceInput: async (inputMode: SttMode) => {
        const radio = document.querySelector<HTMLInputElement>(
          `input[name="voice-mode"][value="${inputMode}"]`,
        );
        if (radio) radio.checked = true;
        await voiceInput(true);
      },
    },
  });
}
```

In `apps/avatar-harness/scripts/capture.mjs`:
- end the `USAGE` string's last line with ` [--chrome-flag=<flag> ...]` (after `[--mute]`);
- add `"chrome-flag": { type: "string", multiple: true, default: [] },` after the `mute` option;
- in `main`, change the launch to
  `const chrome = launchChrome(profile, [...(options.mute ? ["--mute-audio"] : []), ...options["chrome-flag"]]);`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd "/Volumes/Husky's SSD 4T/Projects/localdot-avatar" && pnpm exec vitest run packages/voice apps/avatar-harness`
Expected: all pass, including the 10 new tests (mic 5, listener 3, relay 2).

- [ ] **Step 5: Tell the core session and check LM Studio**

Coordination message (task "Task 9", about 10 minutes) and the LM Studio check, as in Global
Constraints. Wait for the go-ahead.

- [ ] **Step 6: Live — push-to-talk through a fake microphone, then a refused microphone**

Chrome plays a WAV as the microphone. The V0-4 spike's `en-1.wav` (a designed voice saying
"Hey, you're finally back. I sorted your downloads folder while you were gone.", 5.84 s) is local and
git-ignored; copy it to a path without spaces. Chrome's audio service sandbox cannot read that file,
so the microphone would deliver only silence without `--disable-features=AudioServiceSandbox`
(checked while writing this plan: with the flag the clip arrives and then stays silent, so `%noloop`
holds). The warm-up line starts voiced and proves it is up before voice input opens:
```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot-avatar" && MIC=$(mktemp -d) && cp spikes/v04-tts/out/en-1.wav "$MIC/mic.wav" && OUT=$(mktemp -d) && \
(pnpm --filter @localdot/avatar-harness dev > "$OUT/dev.log" 2>&1 &) && \
for i in $(seq 1 80); do curl -s -o /dev/null http://127.0.0.1:4753/ && break; sleep 0.25; done && \
node apps/avatar-harness/scripts/capture.mjs --url "http://127.0.0.1:4753/" --mute --timeout 240000 \
  --chrome-flag=--use-fake-ui-for-media-stream --chrome-flag=--use-fake-device-for-media-stream \
  --chrome-flag="--use-file-for-fake-audio-capture=$MIC/mic.wav%noloop" \
  --chrome-flag=--disable-features=AudioServiceSandbox \
  --wait "window.__voice?.online()" \
  --run 'const v = window.__voice; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); v.say("Warm up."); for (let i = 0; i < 2400 && v.stats().firstAudioMs.length === 0; i++) await sleep(50); await v.voiceInput("ptt"); await v.talk(7000); for (let i = 0; i < 100 && v.stats().utterances.length === 0; i++) await sleep(100);' \
  --eval "window.__voice.stats().utterances" --out "$OUT/ptt.json" --screenshot "$OUT/ptt.png" && cat "$OUT/ptt.json"
```
Expected: one utterance whose `text` contains `downloads folder` (any case) with `lang` `"en"`. The
screenshot shows the Voice input switch on, the panel open, and `You said: …` under it.

Then deny the microphone:
```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot-avatar" && node apps/avatar-harness/scripts/capture.mjs --url "http://127.0.0.1:4753/" --mute \
  --chrome-flag=--deny-permission-prompts --wait "window.__voice?.online()" \
  --run 'await window.__voice.voiceInput("ptt");' \
  --eval "({ note: document.getElementById('mic-note').textContent, on: document.getElementById('voice-input').checked, panelHidden: document.getElementById('voice-input-panel').hidden })"; \
kill $(lsof -tiTCP:4753 -sTCP:LISTEN); sleep 2; lsof -nP -iTCP:4752 -sTCP:LISTEN
```
Expected: `note` starts with "Microphone access is blocked." and mentions site settings and that typing
still works; `on` is `false`; `panelHidden` is `true`; the last `lsof` prints nothing.

- [ ] **Step 7: Check and commit**

```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot-avatar" && pnpm exec biome check --write packages/voice apps/avatar-harness && pnpm lint && pnpm typecheck && pnpm hygiene && \
git add packages/voice apps/avatar-harness && git commit -m "feat(voice): optional voice input with push-to-talk, hands-free and barge-in"
```

Expected: exit 0; one commit.

---

