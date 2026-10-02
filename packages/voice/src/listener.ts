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
