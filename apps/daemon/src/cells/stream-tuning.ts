import {
  parseQualityMessage,
  type StreamQuality,
  type StreamQualityReport,
} from "@localdot/protocol";
import { WebSocket } from "ws";
import type { StreamEndpoint } from "./types.ts";

// The cell image's own start values (SELKIES_FRAMERATE, Selkies' CRF default): what a capture
// runs at while no visible viewer asks for less.
export const FULL_QUALITY: StreamQuality = { framerate: 60, crf: 25 };
// Changes are spaced at least this far apart, however often the viewers change their minds.
const APPLY_GAP_MS = 2000;
const RETRY_MS = { min: 1000, max: 15_000 };
// Selkies refuses a connection from an address that connected less than 500 ms before, and every
// socket of the daemon's comes from one address: the tuner keeps clear of a viewer's.
const JOIN_GAP_MS = 700;

export interface ViewerWish {
  paused: boolean;
  report?: StreamQualityReport;
}

// One capture serves every viewer of a computer, so it runs at the most constrained visible
// viewer's wish: the lowest frame rate and the highest CRF any of them asks for. A hidden page, or
// one whose client paused its video, asks for nothing.
export function sharedQuality(viewers: Iterable<ViewerWish>): StreamQuality {
  let { framerate, crf } = FULL_QUALITY;
  for (const { paused, report } of viewers) {
    if (paused || !report?.visible) continue;
    framerate = Math.min(framerate, report.framerate);
    crf = Math.max(crf, report.crf);
  }
  return { framerate, crf };
}

export interface TunedViewer {
  // Whether `text`, a message from the viewer's client, was for the daemon. Those never reach
  // the computer.
  consume(text: string): boolean;
  leave(): void;
}

// A viewer's round trip on its own stream socket: a ping waits behind every byte queued for it, in
// the daemon and on the link, as its frames do. The client hears it each second as the rtt_ms of the
// stream_stats message Selkies' client already reads; a ping still out counts for as long as it has
// been.
export function probeViewer(ws: WebSocket, everyMs = 1000): () => void {
  let sentAt: number | null = null;
  let smoothed: number | null = null;
  const onPong = () => {
    if (sentAt === null) return;
    const rtt = Date.now() - sentAt;
    sentAt = null;
    smoothed = smoothed === null ? rtt : smoothed * 0.6 + rtt * 0.4;
  };
  ws.on("pong", onPong);
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const waited = sentAt === null ? 0 : now - sentAt;
    if (smoothed !== null || waited > 0) {
      const stats = { rtt_ms: Math.round(Math.max(smoothed ?? 0, waited)) };
      ws.send(JSON.stringify({ type: "stream_stats", displayId: "primary", stats }));
    }
    if (sentAt === null) {
      sentAt = now;
      ws.ping();
    }
  }, everyMs);
  return () => {
    clearInterval(timer);
    ws.off("pong", onPong);
  };
}

export interface StreamTuningOptions {
  applyGapMs?: number;
  joinGapMs?: number;
  retryMs?: { min: number; max: number };
  onApply?(cellId: string, quality: StreamQuality): void;
}
type TuningOptions = StreamTuningOptions &
  Required<Pick<StreamTuningOptions, "applyGapMs" | "joinGapMs" | "retryMs">>;

// Sets each computer's capture to what its viewers can take. Viewers join Selkies as viewers, whose
// settings it ignores, so the daemon holds one controller socket per computer for the settings
// that change live (frame rate and CRF). It opens only once a viewer asks for less than full
// quality, starts with its own video off (SELKIES_VIDEO_ON_START=false) and stays while the
// computer is up: Selkies stops the capture for a few seconds when its controller leaves.
export class StreamTuning {
  readonly #cells = new Map<string, CellTuning>();
  readonly #opts: TuningOptions;

  constructor(opts: StreamTuningOptions = {}) {
    this.#opts = { applyGapMs: APPLY_GAP_MS, joinGapMs: JOIN_GAP_MS, retryMs: RETRY_MS, ...opts };
  }

  join(cellId: string, endpoint: () => StreamEndpoint | undefined): TunedViewer {
    let cell = this.#cells.get(cellId);
    if (!cell) {
      cell = new CellTuning(cellId, this.#opts);
      this.#cells.set(cellId, cell);
    }
    const owner = cell;
    owner.endpoint = endpoint;
    owner.joinedAt = Date.now();
    const wish: ViewerWish = { paused: false };
    owner.viewers.add(wish);
    let left = false;
    return {
      consume(text) {
        if (left) return false;
        if (text === "STOP_VIDEO" || text === "START_VIDEO") {
          wish.paused = text === "STOP_VIDEO";
          owner.update();
          return false;
        }
        const report = parseQualityMessage(text);
        if (report === undefined) return false;
        if (report) {
          wish.report = report;
          owner.update();
        }
        return true;
      },
      leave() {
        if (left) return;
        left = true;
        owner.viewers.delete(wish);
        owner.update();
      },
    };
  }

  // The computer left ready: its Selkies, and the tuner's socket with it, are going.
  drop(cellId: string): void {
    this.#cells.get(cellId)?.close();
    this.#cells.delete(cellId);
  }

  close(): void {
    for (const cell of this.#cells.values()) cell.close();
    this.#cells.clear();
  }
}

class CellTuning {
  readonly viewers = new Set<ViewerWish>();
  endpoint: () => StreamEndpoint | undefined = () => undefined;
  joinedAt = Number.NEGATIVE_INFINITY;
  readonly #id: string;
  readonly #opts: TuningOptions;
  #socket: WebSocket | undefined;
  #open = false;
  // What the open socket last set. A new socket sets it again: Selkies keeps a departed
  // controller's values for the captures it starts later.
  #applied: StreamQuality | null = null;
  #appliedAt = Number.NEGATIVE_INFINITY;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #failures = 0;
  #closed = false;

  constructor(id: string, opts: TuningOptions) {
    this.#id = id;
    this.#opts = opts;
  }

  update(): void {
    if (this.#closed) return;
    const wanted = sharedQuality(this.viewers);
    if (!this.#socket && !this.#retry && !same(wanted, FULL_QUALITY))
      this.#connectAfter(this.joinedAt + this.#opts.joinGapMs - Date.now());
    this.#schedule();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#retry);
    this.#socket?.terminate();
    this.#socket = undefined;
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const socket = this.#socket;
    if (!socket || !this.#open) return;
    const wanted = sharedQuality(this.viewers);
    if (this.#applied && same(wanted, this.#applied)) return;
    const wait = this.#appliedAt + this.#opts.applyGapMs - Date.now();
    if (wait > 0) {
      this.#timer = setTimeout(() => this.#schedule(), wait);
      return;
    }
    // The live verbs: a SETTINGS after the first is a takeover, which costs every viewer a key frame.
    if (this.#applied?.framerate !== wanted.framerate)
      this.#send(socket, `_arg_fps,${wanted.framerate}`);
    if (this.#applied?.crf !== wanted.crf) this.#send(socket, `_crf,${wanted.crf}`);
    this.#applied = wanted;
    this.#appliedAt = Date.now();
    this.#opts.onApply?.(this.#id, wanted);
  }

  #send(socket: WebSocket, message: string): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }

  #connect(): void {
    this.#retry = undefined;
    const endpoint = this.endpoint();
    if (!endpoint) {
      this.#again();
      return;
    }
    // No role: Selkies' controller, the only role whose settings it applies.
    const socket = new WebSocket(`${endpoint.baseUrl.replace(/^http/, "ws")}/api/websockets`, {
      headers: { authorization: endpoint.authorization },
      perMessageDeflate: false,
    });
    this.#socket = socket;
    this.#open = false;
    let paused = false;
    socket.on("open", () => {
      if (this.#socket !== socket) return;
      this.#open = true;
      this.#failures = 0;
      this.#applied = null;
      this.#appliedAt = Number.NEGATIVE_INFINITY;
      // The first SETTINGS claims the primary display, which keeps its geometry and capture; a
      // CRF applies only to a display someone claimed.
      this.#send(
        socket,
        `SETTINGS,${JSON.stringify({ displayId: "primary", use_paint_over_quality: true })}`,
      );
      this.#schedule();
    });
    socket.on("message", (_data, isBinary) => {
      // An image that starts its controller with video on sends it the stream: it pauses its own
      // feed, which keeps the capture for the viewers.
      if (!isBinary || paused) return;
      paused = true;
      socket.send("STOP_VIDEO");
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#open = false;
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#failures++;
      this.#again();
    });
  }

  #again(): void {
    if (this.#closed || this.#retry) return;
    const { min, max } = this.#opts.retryMs;
    this.#connectAfter(Math.min(max, min * 2 ** Math.max(0, this.#failures - 1)));
  }

  #connectAfter(wait: number): void {
    if (wait <= 0) {
      this.#connect();
      return;
    }
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      if (!this.#closed && !this.#socket) this.#connect();
    }, wait);
  }
}

const same = (a: StreamQuality, b: StreamQuality) => a.framerate === b.framerate && a.crf === b.crf;
