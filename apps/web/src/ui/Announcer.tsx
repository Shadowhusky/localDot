import { useSyncExternalStore } from "react";
import { VisuallyHidden } from "./VisuallyHidden.tsx";

// At most one polite announcement this often, so a run of changes is heard in turn, not cut short.
export const ANNOUNCE_GAP = 1500;
// A live region stays silent when its text does not change, so a repeat gains a trailing space.
const REPEAT = " ";

export type Urgency = "polite" | "assertive";

export interface Spoken {
  polite: string;
  assertive: string;
}

export interface AnnouncerQueue {
  // A newer message on the same channel replaces one still waiting there; channels take turns.
  announce(channel: string, text: string, urgency?: Urgency): void;
  // Drops what is still waiting on a channel, once it no longer holds.
  withdraw(channel: string): void;
  spoken(): Spoken;
  subscribe(listener: () => void): () => void;
}

export function createAnnouncer(): AnnouncerQueue {
  let spoken: Spoken = { polite: "", assertive: "" };
  const waiting: { channel: string; text: string }[] = [];
  const listeners = new Set<() => void>();
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const say = (urgency: Urgency, text: string) => {
    spoken = { ...spoken, [urgency]: spoken[urgency] === text ? `${text}${REPEAT}` : text };
    for (const listener of listeners) listener();
  };

  const next = () => {
    timer = undefined;
    const message = waiting.shift();
    if (!message) return;
    last = performance.now();
    say("polite", message.text);
    if (waiting.length > 0) timer = setTimeout(next, ANNOUNCE_GAP);
  };

  return {
    announce(channel, text, urgency = "polite") {
      if (urgency === "assertive") return say("assertive", text);
      const at = waiting.findIndex((message) => message.channel === channel);
      if (at >= 0) waiting[at] = { channel, text };
      else waiting.push({ channel, text });
      if (timer !== undefined) return;
      const wait = last + ANNOUNCE_GAP - performance.now();
      if (wait <= 0) next();
      else timer = setTimeout(next, wait);
    },
    withdraw(channel) {
      const at = waiting.findIndex((message) => message.channel === channel);
      if (at >= 0) waiting.splice(at, 1);
    },
    spoken: () => spoken,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const shared = createAnnouncer();

// Assertive is for errors that stop work; everything else waits its turn politely.
export function announce(channel: string, text: string, urgency?: Urgency): void {
  shared.announce(channel, text, urgency);
}

export function withdraw(channel: string): void {
  shared.withdraw(channel);
}

// The page's only live regions. Mount once, near the root, before anything announces.
export function Announcer() {
  const spoken = useSyncExternalStore(shared.subscribe, shared.spoken, shared.spoken);
  return (
    <>
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {spoken.polite}
      </VisuallyHidden>
      <VisuallyHidden role="alert" aria-live="assertive" aria-atomic="true">
        {spoken.assertive}
      </VisuallyHidden>
    </>
  );
}
