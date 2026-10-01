import { WebSocket } from "ws";
import { PROTOCOL } from "../socket.ts";
import { parseTtsServerMessage } from "../wire.ts";
import { ProviderError, type Sentence, type TtsOutput, type TtsProvider } from "./router.ts";

export interface VoicedEndpoint {
  host: string;
  token: string;
}

export const CONNECT_TIMEOUT_MS = 5000;
const RETRYABLE = new Set<string>(["unavailable", "synthesis_failed"]);

interface Pending {
  id: number;
  audio: boolean;
  resolve(): void;
  reject(error: ProviderError): void;
}

// The local voice: one socket to voiced's /tts per browser connection, relayed unchanged.
export class LocalTts implements TtsProvider {
  readonly kind = "local" as const;
  readonly #endpoint: () => Promise<VoicedEndpoint | null>;
  readonly #out: TtsOutput;
  #socket: Promise<WebSocket> | null = null;
  #pending: Pending | null = null;

  constructor(endpoint: () => Promise<VoicedEndpoint | null>, out: TtsOutput) {
    this.#endpoint = endpoint;
    this.#out = out;
  }

  // Connects ahead of the first sentence; voiced's "ready" then tells the page which voice speaks.
  async warm(): Promise<boolean> {
    try {
      await this.#open();
      return true;
    } catch {
      return false;
    }
  }

  async speak(sentence: Sentence, signal: AbortSignal): Promise<void> {
    const socket = await this.#open();
    // An abort while the connection opened came before the listener below could hear it.
    if (signal.aborted) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        socket.send(JSON.stringify({ type: "cancel" }));
        this.#settle(sentence.id);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending = {
        id: sentence.id,
        audio: false,
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      socket.send(
        JSON.stringify({ type: "say", id: sentence.id, text: sentence.text, lang: sentence.lang }),
      );
    });
  }

  close(): void {
    void this.#socket?.then((socket) => socket.close()).catch(() => {});
    this.#socket = null;
  }

  #settle(id: number): Pending | null {
    const pending = this.#pending;
    if (!pending || pending.id !== id) return null;
    this.#pending = null;
    return pending;
  }

  #open(): Promise<WebSocket> {
    this.#socket ??= this.#connect().catch((error: unknown) => {
      this.#socket = null;
      throw error;
    });
    return this.#socket;
  }

  async #connect(): Promise<WebSocket> {
    const endpoint = await this.#endpoint();
    if (!endpoint) throw new ProviderError("unavailable", "voiced is not running");
    const socket = new WebSocket(`ws://${endpoint.host}/tts`, [PROTOCOL], {
      headers: { authorization: `Bearer ${endpoint.token}` },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
    // voiced greets as soon as it accepts, so listen before the open event can fire.
    socket.on("message", (data, isBinary) => this.#relay(data as Buffer, isBinary));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(new ProviderError("unavailable", error.message)));
    });
    socket.on("close", () => {
      this.#socket = null;
      this.#pending?.reject(
        new ProviderError("unavailable", "voiced closed the connection", this.#pending.audio),
      );
      this.#pending = null;
    });
    socket.on("error", () => {});
    return socket;
  }

  #relay(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (this.#pending && bytes.length >= 4 && data.readUInt32LE(0) === this.#pending.id) {
        this.#pending.audio = true;
      }
      this.#out.frame(bytes);
      return;
    }
    const message = parseTtsServerMessage(data.toString("utf8"));
    if (!message) return;
    if (message.type === "error" && message.id !== null) {
      const pending = this.#settle(message.id);
      // Before any audio another voice can still say the sentence; after it, the page decides.
      if (pending && !pending.audio && RETRYABLE.has(message.code)) {
        pending.reject(new ProviderError(message.code, message.message));
        return;
      }
      this.#out.message(message);
      pending?.resolve();
      return;
    }
    this.#out.message(message);
    if (message.type === "end") this.#settle(message.id)?.resolve();
  }
}
