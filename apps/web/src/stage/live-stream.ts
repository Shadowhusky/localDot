import { qualityMessage, type StreamQualityReport } from "@localdot/protocol";
import type { ApiClient } from "../lib/api.ts";
import { forgetOldTickets } from "./client-storage.ts";
import { type FrameSource, tapVideoTrack } from "./frame-source.ts";
import { streamPreference, streamPreferenceAdopted } from "./stream-preference.ts";
import { framerateCeiling, QualityController, RoundTrips } from "./stream-quality.ts";

export interface StreamTarget {
  api: ApiClient;
  // The computer whose screen this is: the desktop, or the browser that the desktop parents.
  cellId: string;
  surface: "desktop" | "browser";
  parentId?: string;
}

// A held picture means a connection needs recovery. Suspended means this viewer deliberately
// stopped or released its stream while its page is hidden; the computer and its task keep running.
export type StreamPicture = "none" | "live" | "held" | "suspended";

const POLL_MS = 250;
export const STALE_MS = 10_000;
// A stream outlives its stage this long, for a remount, a visit to Replay or the other screen. A
// hidden page keeps its client this long too, with the video stopped.
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
// A client that gets no further towards its first picture for this long is given up on, and each
// try after it is given longer, for a link that is only slow.
export const FIRST_STALL_MS = { min: 8_000, max: 30_000 };
const FIRST_STALL_GROWTH = 1.5;
// A socket that shut before any picture won't bring one, and its client only tries the same ticket
// again in up to 5 s: Selkies refuses a viewer that connects within 500 ms of another, which each
// try gets clear of. A client gets this share of its time.
const FIRST_SHUT_SHARE = 1 / 8;
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
  // How far it has got towards a first picture, and when it last got further.
  reached: number;
  movedAt: number;
  // When its socket was last seen open, or it was made.
  openAt: number;
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
  close?(): void;
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

// How far a client has got towards a first picture: its page, its socket, its video's track, its first
// frame. A client that keeps starting over gets no further than it did. WebKit's client makes its
// track as it starts, so a track is no sign of a socket.
function reach({ video, transport, track, decoded }: ReturnType<typeof look>): number {
  if (decoded > 0) return 4;
  if (!video) return 0;
  if (transport?.readyState !== OPEN) return 1;
  return track ? 3 : 2;
}

// Selkies focuses its own input as it attaches, and `inert` does not stop a frame's own script, so
// each new client would take the keys from whatever the user is typing in. Nothing in a client needs
// focus. The frame's first window carries over to the same-origin page it navigates to.
function withoutFocus(frame: HTMLIFrameElement): void {
  const view = frame.contentWindow as (Window & typeof globalThis) | null;
  if (view?.HTMLElement) view.HTMLElement.prototype.focus = () => {};
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
  // Frames reached the stage and it showed none of them; `insist` is the viewer asking.
  #stageStuck: ((insist: boolean) => void) | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #replacing = false;
  #mintFailures = 0;
  #mintAt = 0;
  #polledAt = 0;
  #patience = STALE_MS;
  #firstStall = FIRST_STALL_MS.min;
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
  readonly #quality = new QualityController(streamPreference(), framerateCeiling());
  readonly #trips = new RoundTrips();
  #tripAt = 0;
  #tunedAt = 0;
  #source: FrameSource | null = null;
  #presentedCount = 0;
  #counted: { client: Client; at: number; decoded: number; presented: number } | null = null;
  #reported: { client: Client; text: string; at: number } | null = null;
  // Polling stopped while this viewer is out of sight: the gap before the next poll is the page's,
  // not a suspension.
  #away = false;
  // The stage is out of sight on a visible page: scrolled away, folded or covered.
  #hidden = false;
  // When the page was hidden, and the timer that lets its kept client go.
  #hiddenAt: number | null = null;
  #release: ReturnType<typeof setTimeout> | undefined;
  #foreground: { client: Client; decoded: number; at: number } | null = null;
  #leaving: ReturnType<typeof setTimeout> | undefined;
  #quietProbe: { client: Client; decoded: number; at: number } | null = null;

  constructor(target: StreamTarget) {
    this.target = target;
    document.addEventListener("visibilitychange", this.#visibility);
    document.addEventListener("freeze", this.#frozen);
  }

  readonly #visibility = () => {
    if (document.visibilityState === "hidden") this.#hide();
    else this.#back();
  };

  // A page the browser freezes may lose its socket before it runs again.
  readonly #frozen = () => {
    if (document.visibilityState === "hidden") this.#suspend();
  };

  // A hidden page stops its video and keeps its client for a short spell away; a long one, or one
  // whose timers never ran (iOS suspends the page), takes a fresh client on return.
  #hide(): void {
    this.#hiddenAt ??= Date.now();
    if (!this.#away) this.#pause(true);
    clearTimeout(this.#release);
    if (this.#current || this.#next) this.#release = setTimeout(() => this.#suspend(), KEEP_MS);
  }

  #back(): void {
    clearTimeout(this.#release);
    const away = this.#hiddenAt === null ? 0 : Date.now() - this.#hiddenAt;
    this.#hiddenAt = null;
    if (away >= KEEP_MS) this.#suspend();
    if (!this.#hidden) this.#resume(TAP_STALL_MS);
  }

  // `within`: a page that was hidden may have lost a socket that still reads as open, so a client with
  // no picture to show for it has only this long to get further.
  #resume(within = this.#firstStall): void {
    if (!this.#away || !this.#sink || this.#closed) return;
    this.#polledAt = Date.now();
    this.#mintAt = 0;
    if (this.#current) {
      this.#current.reached = Math.max(this.#current.reached, reach(look(this.#current)));
      this.#current.movedAt =
        this.#polledAt + Math.min(within, this.#firstStall) - this.#firstStall;
    }
    this.#startPolling();
    this.refresh();
  }

  // Whether this stream's stage is in sight. Out of sight its video stops and its frames are no
  // longer tapped, but its client stays, so the picture returns with a key frame.
  show(shown: boolean): void {
    if (this.#hidden === !shown || this.#closed) return;
    this.#hidden = !shown;
    if (!shown) {
      if (!this.#away) this.#pause(false);
    } else if (document.visibilityState !== "hidden") this.#resume();
  }

  // The most frames a second the stage asks for, as it grows, shrinks or changes hands.
  cap(framerate: number): void {
    this.#quality.cap(framerate);
  }

  #startPolling(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    if (document.visibilityState !== "hidden")
      this.#timer = setInterval(() => this.#poll(), POLL_MS);
  }

  // Stops this viewer's video and frame tap but keeps its client and socket. A client with no open
  // socket yet has nothing to keep, and goes.
  #pause(suspended: boolean): void {
    const { transport } = look(this.#current);
    if (transport?.readyState !== OPEN) {
      this.#suspend(suspended);
      return;
    }
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#source?.stop();
    this.#source = null;
    if (this.#current) this.#current.tapped = null;
    this.#report(this.#current, { visible: false }, Date.now());
    try {
      transport.send?.("STOP_VIDEO");
    } catch {}
    this.#drop(this.#next);
    this.#next = null;
    this.#counted = null;
    this.#foreground = null;
    this.#quietProbe = null;
    this.#awaiting = false;
    this.#away = true;
    this.#mintAt = 0;
    this.#troubleSince = null;
    if (suspended) this.#show("suspended");
  }

  // Retain the stage's last picture, but release the viewer's decoder, transport and frame tap.
  // This affects this viewer only; tasks, recordings and other viewers keep running. A stage out of
  // sight on a visible page keeps the picture's state, which it shows nobody.
  #suspend(suspended = true): void {
    clearTimeout(this.#release);
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#source?.stop();
    this.#source = null;
    this.#report(this.#current, { visible: false }, Date.now());
    this.#drop(this.#current);
    this.#drop(this.#next);
    this.#current = this.#next = null;
    this.#counted = null;
    this.#foreground = null;
    this.#awaiting = false;
    this.#away = true;
    this.#mintAt = 0;
    this.#troubleSince = null;
    if (suspended) this.#show("suspended");
  }

  get picture(): StreamPicture {
    return this.#picture;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  // Hands every new tap to `sink`, starting with one of the client already streaming, if any.
  connect(sink: (source: FrameSource) => void, stageStuck?: (insist: boolean) => void): () => void {
    this.#sink = sink;
    this.#stageStuck = stageStuck ?? null;
    clearTimeout(this.#leaving);
    this.#polledAt = Date.now();
    if (this.#current) {
      this.#current.tapped = null;
      this.#current.movedAt = this.#polledAt;
    }
    this.#startPolling();
    this.#poll();
    return () => {
      if (this.#sink !== sink) return;
      this.#sink = null;
      this.#stageStuck = null;
      clearInterval(this.#timer);
      this.#timer = undefined;
      this.#counted = null;
      // A stream no stage shows asks the shared capture for nothing, unless a stage takes it again
      // at once.
      this.#leaving = setTimeout(() => this.#suspend(), TUNE_MS);
    };
  }

  // The stage presented frames of this stream: `count` so far from its current tap.
  presented(count = this.#presentedCount): void {
    // A queued worker report can arrive after the stream has been released.
    if (this.#closed || this.#away || document.visibilityState === "hidden") return;
    this.#presentedCount = count;
    this.#hadPicture = true;
    this.#firstStall = FIRST_STALL_MS.min;
    this.#presentedAt = Date.now();
    this.#awaiting = false;
    this.#retapped = false;
    if (this.#trackTap) trackReads = true;
    this.#troubleSince = null;
    this.#show("live");
  }

  // The stage started again, without the frames it was being handed.
  retap(): void {
    if (this.#current) this.#current.tapped = null;
  }

  // The daemon may have restarted, which ends its tickets: a different ticket gets a new client.
  renew(): void {
    void this.#mint().then((path) => {
      if (path && path !== (this.#next ?? this.#current)?.path) this.#prepare(path);
    });
  }

  // Resume capture explicitly: the iframe's own visibility event may never have arrived.
  // A fresh decoded frame must prove recovery, even if its socket still claims to be OPEN.
  refresh(): void {
    if (this.#closed || !this.#sink || this.#hidden || document.visibilityState === "hidden")
      return;
    this.#startPolling();
    this.#polledAt = Date.now();
    if (this.#current) this.#current.tapped = null;
    const { transport, decoded } = look(this.#current);
    if (this.#hadPicture && this.#current && !this.#foreground)
      this.#foreground = { client: this.#current, decoded, at: Date.now() };
    if (transport?.readyState === OPEN) {
      try {
        transport.send?.("START_VIDEO");
      } catch {}
      this.#keyframes = 0;
      this.#keyframeAt = Number.NEGATIVE_INFINITY;
      this.#keyframe(transport, Date.now());
    } else if (transport && (transport.readyState ?? OPEN) > OPEN) this.replace();
    else if (transport && !this.#hadPicture) this.#restart();
    this.#poll();
  }

  // The viewer asked to try again: a ticket waiting out its backoff is asked for now, and a fresh
  // client that never showed a frame makes way for another. With no picture yet it does all a refresh
  // would: the stage starts again too.
  retry(): void {
    if (this.#closed) return;
    this.#mintFailures = 0;
    this.#firstStall = FIRST_STALL_MS.min;
    if (!this.#hadPicture) {
      this.#stageStuck?.(true);
      this.#restart();
      return;
    }
    // Frames that reached the stage since it last showed one are its own trouble, not the stream's.
    if ((this.#current?.advancedAt ?? 0) > this.#presentedAt) this.#stageStuck?.(true);
    this.#drop(this.#next);
    this.#next = null;
    this.replace();
  }

  // Everything this viewer holds of its stream goes first, so the client of a fresh ticket never runs
  // beside it.
  #restart(): void {
    this.#source?.stop();
    this.#source = null;
    this.#drop(this.#current);
    this.#drop(this.#next);
    this.#current = this.#next = null;
    this.#counted = null;
    this.#foreground = null;
    this.#awaiting = false;
    this.#retapped = false;
    this.replace();
  }

  // A thawed page can hold an obsolete backlog: a fresh client takes over once it streams.
  replace(): void {
    if (
      this.#closed ||
      !this.#sink ||
      this.#hidden ||
      document.visibilityState === "hidden" ||
      this.#replacing ||
      this.#next
    )
      return;
    this.#replacing = true;
    void this.#mint().then((path) => {
      this.#replacing = false;
      if (path) this.#prepare(path);
    });
  }

  // Close before detaching: a retained track or callback can keep the iframe's
  // realm alive, including its websocket and decoder, after its DOM node is gone.
  #drop(client: Client | null): void {
    if (!client) return;
    const { transport } = look(client);
    try {
      if (transport?.readyState === OPEN) transport.send?.("STOP_VIDEO");
      transport?.close?.();
    } catch {}
    client.frame.remove();
    if (this.#reported?.client === client) this.#reported = null;
    if (this.#quietProbe?.client === client) this.#quietProbe = null;
  }

  close(): void {
    this.#closed = true;
    document.removeEventListener("visibilitychange", this.#visibility);
    document.removeEventListener("freeze", this.#frozen);
    clearTimeout(this.#release);
    this.#source?.stop();
    this.#source = null;
    this.#sink = null;
    clearInterval(this.#timer);
    clearTimeout(this.#leaving);
    this.#drop(this.#current);
    this.#drop(this.#next);
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
    if (this.#closed || !this.#sink || this.#hidden || document.visibilityState === "hidden")
      return;
    this.#drop(this.#next);
    const frame = document.createElement("iframe");
    frame.className = "desktop-frame";
    frame.title = "Desktop stream client";
    frame.setAttribute("inert", "");
    frame.src = `${path}#shared`;
    clientHost().append(frame);
    withoutFocus(frame);
    this.#next = {
      frame,
      path,
      seenAt: Date.now(),
      tapped: null,
      decoded: 0,
      advancedAt: Date.now(),
      reached: 0,
      movedAt: Date.now(),
      openAt: Date.now(),
    };
    this.#poll();
  }

  #poll(): void {
    if (this.#closed || !this.#sink) return;
    const now = Date.now();
    // A hidden page shows nothing, and its throttled timers are not a suspension.
    if (document.visibilityState === "hidden") {
      this.#hide();
      return;
    }
    if (this.#hidden) {
      if (!this.#away) this.#pause(false);
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
    const seen = look(client);
    const { video, track, decoded, transport } = seen;
    if (client && !this.#hadPicture) {
      const reached = reach(seen);
      if (reached > client.reached) {
        client.reached = reached;
        client.movedAt = now;
      } else if (
        now - client.movedAt >=
        this.#firstStall * ((transport?.readyState ?? OPEN) > OPEN ? FIRST_SHUT_SHARE : 1)
      ) {
        // Frames that reached a stage which showed none are its own trouble; and with nothing to lose,
        // a second try does all a refresh would.
        if ((decoded > 0 && track) || this.#firstStall > FIRST_STALL_MS.min)
          this.#stageStuck?.(false);
        this.#firstStall = Math.min(FIRST_STALL_MS.max, this.#firstStall * FIRST_STALL_GROWTH);
        this.#restart();
        return;
      }
    }
    const foreground = this.#foreground;
    if (foreground) {
      if (foreground.client !== client || decoded > foreground.decoded) this.#foreground = null;
      else if (now - foreground.at >= TAP_STALL_MS) {
        foreground.at = now;
        this.replace();
      }
    }
    // An open socket is not proof of video. Ask a quiet encoder for one frame;
    // reconnect this viewer only if that request produces nothing. A still desktop
    // is healthy when it answers, and does not need a continuous high-frame-rate feed.
    if (client && decoded !== client.decoded) client.advancedAt = now;
    if (client && transport?.readyState === OPEN) {
      client.openAt = now;
      const probe = this.#quietProbe;
      if (probe && (probe.client !== client || decoded !== probe.decoded)) this.#quietProbe = null;
      if (this.#quietProbe && now - this.#quietProbe.at >= TAP_STALL_MS) {
        this.#quietProbe = null;
        client.advancedAt = now;
        this.replace();
      } else if (
        this.#hadPicture &&
        !this.#quietProbe &&
        now - (client.advancedAt || client.seenAt) >= STALE_MS
      ) {
        try {
          transport.send?.("REQUEST_KEYFRAME");
          this.#quietProbe = { client, decoded, at: now };
        } catch {
          this.replace();
        }
      }
    } else if (
      client &&
      track &&
      transport &&
      this.#hadPicture &&
      now - Math.max(client.openAt, client.advancedAt) >= STALE_MS
    ) {
      // Selkies' client gives up on some closes, and a socket that never opens never closes.
      client.openAt = now;
      this.replace();
    }
    // A key frame asked of a still screen above is a check, not trouble: over a slow link its
    // answer can take a second, and a screen that never answers is replaced.
    let delivering = false;
    if (client && !video) {
      // An error page, or a client that never loaded; one that keeps failing is given longer.
      if (this.#hadPicture && now - client.seenAt >= this.#patience) {
        client.seenAt = now;
        this.#patience = Math.min(KEEP_MS, this.#patience * 2);
        this.replace();
      }
    } else if (client && video) {
      if (track) client.seenAt = now;
      else if (this.#hadPicture && now - client.seenAt >= STALE_MS) {
        client.seenAt = now;
        this.replace();
      }
      this.#patience = STALE_MS;
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
      } else if (
        track &&
        stalled &&
        now - this.#presentedAt >= (this.#hadPicture ? STALE_MS : TAP_STALL_MS)
      ) {
        this.#presentedAt = now;
        this.#stageStuck?.(false);
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

  // A prepared client takes over once its video shows a frame, or at once when there is no picture
  // to keep or the current client has nothing to show.
  #promote(now: number): void {
    const next = this.#next;
    if (!next) return;
    const fresh = look(next);
    if (
      !this.#hadPicture ||
      (fresh.track && (fresh.video?.readyState ?? 0) >= SHOWING) ||
      !look(this.#current).track
    ) {
      this.#drop(this.#current);
      this.#current = next;
      this.#next = null;
    } else if (now - next.seenAt >= STALE_MS) {
      this.#drop(next);
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
    const preference = streamPreference();
    this.#quality.prefer(preference);
    this.#roundTrip(client, now);
    const decoded = Math.max(client.decoded, this.#source?.delivered?.() ?? 0);
    const last = this.#counted;
    this.#counted = { client, at: now, decoded, presented: this.#presentedCount };
    if (last?.client !== client || now <= last.at) {
      if (this.#report(client, { visible: true, ...this.#quality.quality }, now))
        streamPreferenceAdopted(preference, this.#quality.quality);
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
    if (this.#report(client, { visible: true, ...quality }, now))
      streamPreferenceAdopted(preference, quality);
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

  #report(client: Client | null, report: StreamQualityReport, now: number): boolean {
    const { transport } = look(client);
    if (!client || transport?.readyState !== OPEN || typeof transport.send !== "function")
      return false;
    const text = qualityMessage(report);
    const last = this.#reported;
    if (last?.client === client && last.text === text && now - last.at < REPORT_EVERY_MS)
      return true;
    try {
      transport.send(text);
      this.#reported = { client, text, at: now };
      return true;
    } catch {
      return false;
    }
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
  `${target.surface}/${target.cellId}/${target.surface === "browser" ? (target.parentId ?? "") : ""}`;

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
