import type { LocalDotEvent, PersonaId } from "@localdot/protocol";

// One cut of a recorded task: session milliseconds [from, to] play at `speed`, starting at video
// millisecond `at`. Cuts are in order and never overlap.
export interface Segment {
  from: number;
  to: number;
  speed: number;
  at: number;
}

export interface DemoResult {
  name: string;
  kind: "image" | "pdf" | "video" | "game";
  src: string;
  poster?: string;
}

// A demo: a real task's events, the Theatre video the app exported from its recording, and how the
// two line up.
export interface DemoTimeline {
  v: 1;
  id: string;
  // The recorded task's own session, which the app's file links name.
  sessionId: string;
  // The conversation's title, as the app's top bar shows it.
  title: string;
  // The request as the visitor sees it sent.
  prompt: string;
  persona: PersonaId;
  model: { route: string; model: string; label: string };
  costUSD?: number;
  // How long the task really took, in ms.
  realMs: number;
  // The Theatre's recording, and a lighter copy for phones.
  video: { src: string; small?: string; poster: string; width: number; height: number; ms: number };
  segments: Segment[];
  // Session events, their `t` in session microseconds as recorded.
  events: LocalDotEvent[];
  results: DemoResult[];
  // What the app asks the daemon about this task's results, by the path after
  // "/api/agent/sessions/<session>/", saved with the type the daemon answered with.
  api: Record<string, { src: string; type: string }>;
  // Where the app's preview links point: the folder the result files themselves are in.
  previews: string;
}

// A preview link's ticket for a demo: the daemon's are 43 random characters; a demo's is its name.
export const previewTicket = (id: string) => id.padEnd(43, "-").slice(0, 43);

const length = (s: Segment) => (s.to - s.from) / s.speed;

export function toSession(videoMs: number, segments: readonly Segment[]): number {
  const first = segments[0];
  const last = segments.at(-1);
  if (!first || !last) return 0;
  if (videoMs <= first.at) return first.from;
  for (const s of segments) {
    if (videoMs < s.at + length(s)) return s.from + Math.max(0, videoMs - s.at) * s.speed;
  }
  return last.to;
}

export function toVideo(sessionMs: number, segments: readonly Segment[]): number | null {
  for (const s of segments) {
    if (sessionMs >= s.from && sessionMs <= s.to) return s.at + (sessionMs - s.from) / s.speed;
  }
  return null;
}

// Events a visitor never sees, or that name the owner's keys and safety bookkeeping.
const DROPPED = new Set(["thought.delta", "message.delta", "heartbeat", "key.use", "safety.taint"]);

export function prune(events: readonly LocalDotEvent[]): LocalDotEvent[] {
  return events.filter((event) => !DROPPED.has(event.type));
}
