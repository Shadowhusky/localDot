import WebSocket, { type RawData } from "ws";
import { STREAM_PING_MS, STREAM_STALL_MS } from "../cells/stream-proxy.ts";
import type { StreamEndpoint } from "../cells/types.ts";
import { StallWatchdog } from "../cells/watchdog.ts";
import type { Clock } from "../clock.ts";
import { isRandomAccess } from "./annexb.ts";
import { CODEC_H264, parseSelkiesMessage } from "./wire.ts";

export interface FeedFrame {
  arrivalMicros: number;
  key: boolean;
  width: number;
  height: number;
  data: Uint8Array;
}
export type FeedState = "connecting" | "live" | "lost" | "stopped";
export const PIPELINE_RESET = "pipeline-reset";
export interface FeedHandlers {
  onFrame(frame: FeedFrame): void;
  onState(state: FeedState, detail?: string): void;
}
export interface FrameFeed {
  start(): void;
  requestKeyframe(): void;
  stop(): void;
}
export type HandshakeStep = { await: string } | { send: string } | { waitMs: number };
export const RECORDER_HANDSHAKE: readonly HandshakeStep[] = [
  { await: "MODE websockets" },
  { send: "STOP_VIDEO" },
  { waitMs: 250 },
  { send: "START_VIDEO" },
];
export const KEY_REQUEST_MIN_GAP_MS = 500;
export const FEED_BACKOFF_MS = [500, 1000, 2000, 4000] as const;
export const VIDEO_RESTART_AFTER_MS = 3000;
export const VIDEO_RESTART_MAX_MS = 30_000;
export interface SelkiesFeedOptions {
  endpoint(): StreamEndpoint | undefined;
  clock: Clock;
  handlers: FeedHandlers;
  handshake?: readonly HandshakeStep[];
  dialTimeoutMs?: number;
  pingEveryMs?: number;
  stallAfterMs?: number;
  videoRestartAfterMs?: number;
}
function bytesOf(data: RawData): Uint8Array {
  return Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data;
}

export class SelkiesFeed implements FrameFeed {
  readonly #opts: SelkiesFeedOptions;
  readonly #handshake: readonly HandshakeStep[];
  #active = false;
  #ws: WebSocket | undefined;
  #watchdog: StallWatchdog | undefined;
  #dialTimer: ReturnType<typeof setTimeout> | undefined;
  #waitTimer: ReturnType<typeof setTimeout> | undefined;
  #videoTimer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #step = 0;
  #live = false;
  #ignored = false;
  #attempt = 0;
  #videoAttempt = 0;
  #lastKeyAt = Number.NEGATIVE_INFINITY;

  constructor(opts: SelkiesFeedOptions) {
    for (const value of [
      opts.dialTimeoutMs,
      opts.pingEveryMs,
      opts.stallAfterMs,
      opts.videoRestartAfterMs,
    ])
      if (value !== undefined && (!Number.isFinite(value) || value <= 0))
        throw new RangeError("feed intervals must be positive and finite");
    this.#opts = opts;
    this.#handshake = opts.handshake ?? RECORDER_HANDSHAKE;
    for (const step of this.#handshake)
      if ("waitMs" in step && (!Number.isFinite(step.waitMs) || step.waitMs < 0))
        throw new RangeError("handshake waits must be finite and nonnegative");
  }
  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#attempt = 0;
    this.#dial();
  }
  requestKeyframe(): void {
    const ws = this.#ws;
    const now = performance.now();
    if (
      !this.#active ||
      ws?.readyState !== WebSocket.OPEN ||
      now - this.#lastKeyAt < KEY_REQUEST_MIN_GAP_MS
    )
      return;
    this.#lastKeyAt = now;
    ws.send("REQUEST_KEYFRAME");
  }
  stop(): void {
    if (!this.#active) return;
    this.#active = false;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#clearConnection();
    this.#opts.handlers.onState("stopped");
  }
  #clearConnection(): void {
    clearTimeout(this.#dialTimer);
    clearTimeout(this.#waitTimer);
    clearTimeout(this.#videoTimer);
    this.#dialTimer = this.#waitTimer = this.#videoTimer = undefined;
    this.#watchdog?.stop();
    this.#watchdog = undefined;
    const ws = this.#ws;
    this.#ws = undefined;
    this.#live = false;
    ws?.terminate();
  }
  #retry(): void {
    if (!this.#active) return;
    const delay = FEED_BACKOFF_MS[Math.min(this.#attempt++, FEED_BACKOFF_MS.length - 1)] ?? 4000;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#dial();
    }, delay);
  }
  #lost(ws: WebSocket, detail: string): void {
    if (!this.#active || this.#ws !== ws) return;
    this.#clearConnection();
    this.#opts.handlers.onState("lost", detail);
    this.#retry();
  }
  #dial(): void {
    if (!this.#active) return;
    this.#opts.handlers.onState("connecting");
    if (!this.#active) return;
    let ws: WebSocket;
    try {
      const endpoint = this.#opts.endpoint();
      if (!endpoint) {
        this.#opts.handlers.onState("lost", "cell stream unavailable");
        this.#retry();
        return;
      }
      // S9 measured the same fixed viewer role used by the accepted Theatre relay.
      const url = new URL(endpoint.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("invalid stream endpoint");
      url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
      url.pathname = "/api/websockets";
      url.search = "?role=viewer";
      url.hash = "";
      ws = new WebSocket(url, {
        headers: { authorization: endpoint.authorization },
        perMessageDeflate: false,
      });
    } catch {
      // Never expose endpoint, headers or ws's URL-bearing error message.
      this.#opts.handlers.onState("lost", "stream dial failed");
      this.#retry();
      return;
    }
    this.#ws = ws;
    this.#step = 0;
    this.#ignored = false;
    this.#lastKeyAt = Number.NEGATIVE_INFINITY;
    const timeout = this.#opts.dialTimeoutMs ?? 10_000;
    this.#dialTimer = setTimeout(() => this.#lost(ws, "stream dial timed out"), timeout);
    ws.on("open", () => {
      if (!this.#active || this.#ws !== ws) return;
      clearTimeout(this.#dialTimer);
      // A live socket that never completes MODE must not stay connecting forever.
      this.#dialTimer = setTimeout(() => this.#lost(ws, "stream handshake timed out"), timeout);
      this.#watchdog = new StallWatchdog({
        pingEveryMs: this.#opts.pingEveryMs ?? STREAM_PING_MS,
        stallAfterMs: this.#opts.stallAfterMs ?? STREAM_STALL_MS,
        ping: () => {
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        },
        onChange: (state) => {
          if (state === "stalled") this.#lost(ws, "stream stalled");
        },
      });
      this.#watchdog.start();
      this.#advance(ws);
    });
    ws.on("pong", () => {
      if (this.#ws === ws) this.#watchdog?.touch();
    });
    ws.on("message", (data, binary) => {
      if (!this.#active || this.#ws !== ws) return;
      const arrivalMicros = this.#opts.clock.nowMicros();
      this.#watchdog?.touch();
      const bytes = bytesOf(data);
      if (!binary) {
        const text = Buffer.from(bytes).toString("utf8");
        const step = this.#handshake[this.#step];
        if (step && "await" in step && text === step.await) {
          this.#step++;
          this.#advance(ws);
        } else if (
          this.#live &&
          /^(?:PIPELINE_RESETTING|PIPELINE_RESETTING primary)$/.test(text.trim())
        ) {
          this.#opts.handlers.onState("live", PIPELINE_RESET);
          this.#armVideo(ws, true);
        }
        return;
      }
      if (!this.#live) return;
      const message = parseSelkiesMessage(bytes);
      if (message.kind !== "video") return;
      this.#armVideo(ws, true);
      if (message.codec !== CODEC_H264 || message.region !== 0) {
        if (!this.#ignored) {
          this.#ignored = true;
          this.#opts.handlers.onState("live", "ignored a non-H.264 or striped frame");
        }
        return;
      }
      this.#opts.handlers.onFrame({
        arrivalMicros,
        key: message.key && isRandomAccess(message.data),
        width: message.width,
        height: message.height,
        data: message.data,
      });
    });
    ws.on("error", () => this.#lost(ws, "stream connection failed"));
    ws.on("close", () => this.#lost(ws, "stream closed"));
  }
  #advance(ws: WebSocket): void {
    if (!this.#active || this.#ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    while (this.#step < this.#handshake.length) {
      const step = this.#handshake[this.#step];
      if (!step || "await" in step) return;
      this.#step++;
      if ("waitMs" in step) {
        this.#waitTimer = setTimeout(() => {
          this.#waitTimer = undefined;
          this.#advance(ws);
        }, step.waitMs);
        return;
      }
      ws.send(step.send);
      if (step.send === "START_VIDEO") this.#armVideo(ws, true);
    }
    clearTimeout(this.#dialTimer);
    this.#dialTimer = undefined;
    this.#live = true;
    this.#attempt = 0;
    this.#opts.handlers.onState("live");
  }
  #armVideo(ws: WebSocket, reset: boolean): void {
    if (!this.#active || this.#ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    if (reset) this.#videoAttempt = 0;
    clearTimeout(this.#videoTimer);
    const base = this.#opts.videoRestartAfterMs ?? VIDEO_RESTART_AFTER_MS;
    const delay = Math.min(base * 2 ** this.#videoAttempt, VIDEO_RESTART_MAX_MS);
    this.#videoTimer = setTimeout(() => {
      if (!this.#active || this.#ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send("START_VIDEO");
      this.#videoAttempt++;
      this.#armVideo(ws, false);
    }, delay);
  }
}
