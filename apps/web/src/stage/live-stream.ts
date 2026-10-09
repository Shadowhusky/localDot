import { qualityMessage, type StreamQualityReport } from "@localdot/protocol";
import type { ApiClient } from "../lib/api.ts";
import { forgetOldTickets } from "./client-storage.ts";
import { type FrameSource, tapVideoTrack } from "./frame-source.ts";
import { streamPreference } from "./stream-preference.ts";
import { QualityController, RoundTrips } from "./stream-quality.ts";

export interface StreamTarget {
  api: ApiClient;
  // The computer whose screen this is: the desktop, or the browser that the desktop parents.
  cellId: string;
  surface: "desktop" | "browser";
  parentId?: string;
}

// What the stage holds of a stream: nothing yet, its live picture, or its last picture kept while
// the stream reconnects.
export type StreamPicture = "none" | "live" | "held";

const POLL_MS = 250;
export const STALE_MS = 10_000;
// A stream outlives its stage this long, for a remount, a visit to Replay or the other screen.
export const KEEP_MS = 60_000;
// A shorter reconnect says nothing.
export const HELD_AFTER_MS = 1_000;
// A tap that shows nothing this soon asks the encoder for a key frame.
export const FIRST_FRAME_MS = 400;
const KEYFRAME_EVERY_MS = 1_000;
const KEYFRAME_TRIES = 3;
// The decoder runs ahead of a tap that presents nothing: the tap is taken again, then the client.
export const TAP_STALL_MS = 3_000;
// A track handed to the worker that shows nothing this long while the decoder runs is taken again;
// one that fails twice running is not tried again, and the video's frames are copied instead.
export const TRACK_PROOF_MS = 1_500;
const TRACK_TRIES = 2;
// Whether the worker's own read of a track shows frames in this browser: unknown, proven or given
// up on. Every stream of the page shares it, so a later one never waits out a failed proof again.
let trackReads: boolean | null = null;
let trackFailures = 0;
const MINT_RETRY_MS = { min: 1_000, max: 15_000 };
// The stream's quality is judged this often, and a viewer's wish repeated this often for a relay
// that may have restarted under the same client.
export const TUNE_MS = 1_000;
const REPORT_EVERY_MS = 10_000;
// A round trip the relay reported longer ago than this is no longer news.
const STATS_FRESH_MS = 3_000;
const TICKET_PATH = /^\/cells\/[^/]+\/(?:desktop|browser)\/[A-Za-z0-9_-]{22}\/$/;
const OPEN = 1;
// HAVE_CURRENT_DATA: the client's video has shown a frame.
const SHOWING = 2;

interface Client {
  frame: HTMLIFrameElement;
  path: string;
  // When the client last had a video element, or was made.
  seenAt: number;
  tapped: string | null;
  decoded: number;
  // When its decoder last produced a frame.
  advancedAt: number;
}

// Selkies' objects live in the client's realm, so they are read by shape.
interface ClientView {
  selkiesTransport?: Transport | null;
  stream_stats?: ClientStats | null;
  // Frames that reached its decoder so far. WebKit's video counts none of a track a worker writes.
  videoChunksReceived?: unknown;
}

interface ClientVideo {
  tagName?: string;
  srcObject: unknown;
  readyState?: number;
  getVideoPlaybackQuality?(): { totalVideoFrames: number };
}

interface Transport {
  readyState?: number;
  send?(data: string): void;
}

// What Selkies' client keeps of its stream's numbers once they are asked for: each second, its own
// with the last the server (here the daemon's relay) sent.
interface ClientStats {
  open?: boolean;
  latest?: { t?: number; rtt_ms?: unknown } | null;
}

function look(client: Client | null) {
  let doc: Document | null = null;
  let view: ClientView | null = null;
  try {
    doc = client?.frame.contentDocument ?? null;
    view = client?.frame.contentWindow as ClientView | null;
  } catch {}
  const element = doc?.getElementById("videoStream") as ClientVideo | null | undefined;
  const video = element?.tagName === "VIDEO" ? element : null;
  const stream = video?.srcObject as { getVideoTracks?: () => { id: string }[] } | null | undefined;
  const track =
    typeof stream?.getVideoTracks === "function" ? stream.getVideoTracks()[0] : undefined;
  const chunks = typeof view?.videoChunksReceived === "number" ? view.videoChunksReceived : 0;
  const decoded = Math.max(video?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0, chunks);
  return { video, track, decoded, transport: view?.selkiesTransport, stats: view?.stream_stats };
}

let host: HTMLElement | null = null;
// Clients live outside every stage, so moving or remounting the stage never reloads them.
function clientHost(): HTMLElement {
  if (host?.isConnected) return host;
  host = document.createElement("div");
  host.className = "stage-clients";
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("inert", "");
  document.body.append(host);
  return host;
}

// One screen's stream, independent of React: Selkies' client in a hidden iframe, its ticket, and the
// tap that hands its frames to the stage. A reconnect replaces the client only once a fresh one
// shows a frame, so the stage keeps its last picture meanwhile.
export class LiveStream {
  readonly target: StreamTarget;
  listed: () => readonly string[] = () => [];
  #current: Client | null = null;
  #next: Client | null = null;
  #sink: ((source: FrameSource) => void) | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #replacing = false;
  #mintFailures = 0;
  #mintAt = 0;
  #polledAt = 0;
  #patience = STALE_MS;
  #presentedAt = 0;
  #retapped = false;
  #awaiting = false;
  #tappedAt = 0;
  // The current tap handed the worker a track, and the decoder's count when it was taken.
  #trackTap = false;
  #tapDecoded = 0;
  #keyframeAt = 0;
  #keyframes = 0;
  #hadPicture = false;
  #troubleSince: number | null = null;
  #picture: StreamPicture = "none";
  #listeners = new Set<() => void>();
  readonly #quality = new QualityController(streamPreference());
  readonly #trips = new RoundTrips();
  #tripAt = 0;
  #tunedAt = 0;
  #source: FrameSource | null = null;
  #presentedCount = 0;
  #counted: { client: Client; at: number; decoded: number; presented: number } | null = null;
  #reported: { client: Client; text: string; at: number } | null = null;
  // The last poll found the page hidden: the gap before the next is the page's, not a suspension.
  #away = false;
  #leaving: ReturnType<typeof setTimeout> | undefined;

  constructor(target: StreamTarget) {
    this.target = target;
  }

  get picture(): StreamPicture {
    return this.#picture;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  // Hands every new tap to `sink`, starting with one of the client already streaming, if any.
  connect(sink: (source: FrameSource) => void): () => void {
    this.#sink = sink;
    clearTimeout(this.#leaving);
    if (this.#current) this.#current.tapped = null;
    this.#polledAt = Date.now();
    clearInterval(this.#timer);
    this.#timer = setInterval(() => this.#poll(), POLL_MS);
    this.#poll();
    return () => {
      if (this.#sink !== sink) return;
      this.#sink = null;
      clearInterval(this.#timer);
      this.#timer = undefined;
      this.#counted = null;
      // A stream no stage shows asks the shared capture for nothing, unless a stage takes it again
      // at once.
      this.#leaving = setTimeout(
        () => this.#report(this.#current, { visible: false }, Date.now()),
        TUNE_MS,
      );
    };
  }

  // The stage presented frames of this stream: `count` so far from its current tap.
  presented(count = this.#presentedCount): void {
    this.#presentedCount = count;
    this.#hadPicture = true;
    this.#presentedAt = Date.now();
    this.#awaiting = false;
    this.#retapped = false;
    if (this.#trackTap) trackReads = true;
    this.#troubleSince = null;
    this.#show("live");
  }

  // The daemon may have restarted, which ends its tickets: a different ticket gets a new client.
  renew(): void {
    void this.#mint().then((path) => {
      if (path && path !== (this.#next ?? this.#current)?.path) this.#prepare(path);
    });
  }

  // The page is visible again: its frames are taken afresh. Its client paused its feed while hidden
  // (Selkies' STOP_VIDEO), so it holds no backlog; only a client whose socket died is replaced.
  refresh(): void {
    this.#polledAt = Date.now();
    if (this.#current) this.#current.tapped = null;
    const { transport } = look(this.#current);
    if (transport && (transport.readyState ?? OPEN) > OPEN) this.replace();
    this.#poll();
  }

  // A thawed page can hold an obsolete backlog: a fresh client takes over once it streams.
  replace(): void {
    if (this.#replacing) return;
    this.#replacing = true;
    void this.#mint().then((path) => {
      this.#replacing = false;
      if (path) this.#prepare(path);
    });
  }

  close(): void {
    this.#closed = true;
    this.#sink = null;
    clearInterval(this.#timer);
    clearTimeout(this.#leaving);
    this.#current?.frame.remove();
    this.#next?.frame.remove();
    this.#current = this.#next = null;
    this.#listeners.clear();
  }

  async #mint(): Promise<string | null> {
    const { api, cellId, surface, parentId } = this.target;
    this.#mintAt = Date.now();
    try {
      const { path, cellId: physicalId } = await api.post<{ path?: unknown; cellId?: string }>(
        surface === "browser"
          ? `/api/cells/${parentId}/browser-stream-ticket`
          : `/api/cells/${cellId}/stream-ticket`,
      );
      if (this.#closed) return null;
      if (
        typeof path !== "string" ||
        !path.startsWith(`/cells/${cellId}/${surface}/`) ||
        (surface === "browser" && physicalId !== cellId) ||
        !TICKET_PATH.test(path)
      ) {
        this.#mintFailures++;
        return null;
      }
      this.#mintFailures = 0;
      forgetOldTickets({ cellId, livePath: path, listed: this.listed() });
      return path;
    } catch {
      this.#mintFailures++;
      return null;
    }
  }

  #prepare(path: string): void {
    if (this.#closed) return;
    this.#next?.frame.remove();
    const frame = document.createElement("iframe");
    frame.className = "desktop-frame";
    frame.title = "Desktop stream client";
    frame.setAttribute("inert", "");
    frame.src = `${path}#shared`;
    clientHost().append(frame);
    this.#next = { frame, path, seenAt: Date.now(), tapped: null, decoded: 0, advancedAt: 0 };
    this.#poll();
  }

  #poll(): void {
    if (this.#closed || !this.#sink) return;
    const now = Date.now();
    // A hidden page shows nothing, and its throttled timers are not a suspension.
    if (document.visibilityState === "hidden") {
      this.#polledAt = now;
      this.#away = true;
      this.#report(this.#current, { visible: false }, now);
      this.#counted = null;
      return;
    }
    // Timers that stopped this long on a visible page mean it was suspended, and its socket may
    // hold an old backlog.
    if (!this.#away && now - this.#polledAt >= STALE_MS) this.replace();
    this.#away = false;
    this.#polledAt = now;
    this.#promote(now);
    const client = this.#current;
    const retry = Math.min(MINT_RETRY_MS.max, MINT_RETRY_MS.min * 2 ** this.#mintFailures);
    if (!client && !this.#next && now - this.#mintAt >= retry) this.replace();
    const { video, track, decoded, transport } = look(client);
    let delivering = false;
    if (client && !video) {
      // An error page, or a client that never loaded; one that keeps failing is given longer.
      if (now - client.seenAt >= this.#patience) {
        client.seenAt = now;
        this.#patience = Math.min(KEEP_MS, this.#patience * 2);
        this.replace();
      }
    } else if (client && video) {
      client.seenAt = now;
      this.#patience = STALE_MS;
      if (decoded > client.decoded) client.advancedAt = now;
      client.decoded = decoded;
      // The decoder has run on well past the last frame the stage presented.
      const stalled = client.advancedAt - this.#presentedAt >= TAP_STALL_MS;
      const unproven =
        this.#trackTap &&
        this.#awaiting &&
        trackReads === null &&
        decoded > this.#tapDecoded &&
        now - this.#tappedAt >= TRACK_PROOF_MS;
      if (track && track.id !== client.tapped) this.#tap(client, video, transport, now);
      else if (track && unproven) {
        if (++trackFailures >= TRACK_TRIES) trackReads = false;
        this.#tap(client, video, transport, now);
      } else if (track && stalled && !this.#retapped) {
        this.#retapped = true;
        this.#tap(client, video, transport, now);
      } else if (track && stalled && now - this.#presentedAt >= STALE_MS) {
        this.#presentedAt = now;
        this.replace();
      } else delivering = !!track && !stalled && !this.#awaiting;
    }
    if (transport && transport.readyState !== OPEN) delivering = false;
    if (client && video && now - this.#tunedAt >= TUNE_MS) this.#tune(client, now);
    if (this.#awaiting && now - this.#tappedAt >= FIRST_FRAME_MS) this.#keyframe(transport, now);
    if (delivering) this.#troubleSince = null;
    else this.#troubleSince ??= now;
    this.#show(
      !this.#hadPicture
        ? "none"
        : this.#troubleSince !== null && now - this.#troubleSince >= HELD_AFTER_MS
          ? "held"
          : "live",
    );
  }

  // A prepared client takes over once its video shows a frame, or at once when the current client
  // has nothing to show.
  #promote(now: number): void {
    const next = this.#next;
    if (!next) return;
    const fresh = look(next);
    if ((fresh.track && (fresh.video?.readyState ?? 0) >= SHOWING) || !look(this.#current).track) {
      this.#current?.frame.remove();
      this.#current = next;
      this.#next = null;
    } else if (now - next.seenAt >= STALE_MS) {
      next.frame.remove();
      this.#next = null;
    }
  }

  #tap(
    client: Client,
    video: ClientVideo,
    transport: Transport | null | undefined,
    now: number,
  ): void {
    const source = tapVideoTrack(video, { tracks: trackReads !== false });
    if (!source) return;
    this.#source = source;
    // The stage's count starts again with the new tap.
    this.#counted = null;
    client.tapped = source.trackId;
    this.#presentedAt = now;
    this.#tappedAt = now;
    this.#awaiting = true;
    this.#trackTap = !!source.track;
    this.#tapDecoded = client.decoded;
    this.#keyframes = 0;
    // Without the video's current frame, the stage waits for the next one: a still screen sends
    // none, so a key frame is asked for at once.
    if (!source.first) this.#keyframe(transport, now);
    if (this.#sink) this.#sink(source);
    else source.stop();
  }

  // One second of the stream: what the decoder produced, what the stage presented, and the round
  // trip the relay measured on the stream's own socket, decide the quality this viewer asks for.
  #tune(client: Client, now: number): void {
    this.#tunedAt = now;
    this.#quality.prefer(streamPreference());
    this.#roundTrip(client, now);
    const decoded = Math.max(client.decoded, this.#source?.delivered?.() ?? 0);
    const last = this.#counted;
    this.#counted = { client, at: now, decoded, presented: this.#presentedCount };
    if (last?.client !== client || now <= last.at) {
      this.#report(client, { visible: true, ...this.#quality.quality }, now);
      return;
    }
    const seconds = (now - last.at) / 1000;
    // A count that went down started again, with a new pump.
    const since = (count: number, before: number) => (count >= before ? count - before : count);
    const quality = this.#quality.tick({
      rttMs: this.#trips.smoothed,
      baseRttMs: this.#trips.base,
      decodedFps: since(decoded, last.decoded) / seconds,
      presentedFps: since(this.#presentedCount, last.presented) / seconds,
    });
    this.#report(client, { visible: true, ...quality }, now);
  }

  // Selkies' client keeps the numbers only once they are asked for, as its own stats panel does.
  #roundTrip(client: Client, now: number): void {
    const { stats } = look(client);
    if (!stats?.open) {
      try {
        client.frame.contentWindow?.postMessage(
          { type: "statsOpen", open: true },
          window.location.origin,
        );
      } catch {}
      return;
    }
    const { t, rtt_ms: rtt } = stats.latest ?? {};
    if (typeof t !== "number" || typeof rtt !== "number" || t === this.#tripAt) return;
    if (now - t > STATS_FRESH_MS) return;
    this.#tripAt = t;
    this.#trips.add(rtt);
  }

  #report(client: Client | null, report: StreamQualityReport, now: number): void {
    const { transport } = look(client);
    if (!client || transport?.readyState !== OPEN || typeof transport.send !== "function") return;
    const text = qualityMessage(report);
    const last = this.#reported;
    if (last?.client === client && last.text === text && now - last.at < REPORT_EVERY_MS) return;
    try {
      transport.send(text);
      this.#reported = { client, text, at: now };
    } catch {}
  }

  // Selkies accepts a viewer's key frame request; its encoder otherwise sends only what changed, so
  // a fresh tap of a still screen would wait for the next change.
  #keyframe(transport: Transport | null | undefined, now: number): void {
    if (this.#keyframes >= KEYFRAME_TRIES || now - this.#keyframeAt < KEYFRAME_EVERY_MS) return;
    if (transport?.readyState !== OPEN || typeof transport.send !== "function") return;
    this.#keyframeAt = now;
    this.#keyframes++;
    try {
      transport.send("REQUEST_KEYFRAME");
    } catch {}
  }

  #show(picture: StreamPicture): void {
    if (picture === this.#picture) return;
    this.#picture = picture;
    for (const listener of this.#listeners) listener();
  }
}

interface Held {
  stream: LiveStream;
  holders: number;
  timer?: ReturnType<typeof setTimeout>;
  close(): void;
}

const held = new WeakMap<ApiClient, Map<string, Held>>();
const closers = new Set<() => void>();
const keyOf = (target: StreamTarget) =>
  `${target.surface}/${target.cellId}/${target.parentId ?? ""}`;

// The stream a stage that remounts can show at once, held or kept.
export function findStream(target: StreamTarget): LiveStream | undefined {
  return held.get(target.api)?.get(keyOf(target))?.stream;
}

// The stream of a screen, shared by every stage that shows it. Its last holder lets it go at once
// (its computer stopped) or after `keepMs` (the stage may come back).
export function holdStream(
  target: StreamTarget,
  listed: () => readonly string[],
): { stream: LiveStream; release(keepMs: number): void } {
  const key = keyOf(target);
  const map = held.get(target.api) ?? new Map<string, Held>();
  held.set(target.api, map);
  let found = map.get(key);
  if (!found) {
    const stream = new LiveStream(target);
    const fresh: Held = {
      stream,
      holders: 0,
      close: () => {
        clearTimeout(fresh.timer);
        closers.delete(fresh.close);
        if (map.get(key) === fresh) map.delete(key);
        stream.close();
      },
    };
    closers.add(fresh.close);
    map.set(key, fresh);
    stream.replace();
    found = fresh;
  }
  const own = found;
  clearTimeout(own.timer);
  own.holders++;
  own.stream.listed = listed;
  let released = false;
  return {
    stream: own.stream,
    release(keepMs) {
      if (released) return;
      released = true;
      if (--own.holders > 0) return;
      if (keepMs > 0) own.timer = setTimeout(own.close, keepMs);
      else own.close();
    },
  };
}

// Closes every stream, held or kept, and forgets what they learned of this browser.
export function closeStreams(): void {
  for (const close of [...closers]) close();
  trackReads = null;
  trackFailures = 0;
}
