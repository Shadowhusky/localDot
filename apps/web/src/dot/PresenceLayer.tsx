import { useEffect, useRef, useState } from "react";
import { REDUCED_MOTION, useMediaQuery } from "../ui/media.ts";
import { type DotFeed, sayMs } from "./dot-feed.ts";
import type { DotState } from "./engine/states.ts";
import { useEntrance } from "./entrance.ts";
import { Glyph } from "./Glyph.tsx";
import { onPlaces } from "./places.ts";
import { Presence } from "./presence.ts";
import type { PresencePlace } from "./presence-rules.ts";
import { useReplayPresence } from "./replay-presence.ts";
import "./dot.css";

const RESTING_MS = 60_000;
const DOZING_MS = 5 * 60_000;
const AWAY_MS = 30_000;
const COMPOSER = ".composer textarea";

export interface PresenceLayerProps {
  place: PresencePlace | null;
  // The place is a guess until what the computer is doing is known.
  provisional?: boolean;
  feed: DotFeed;
  // dot's line beside the stage; each new one gets a talk-bob.
  line: string;
}

// The one live dot (design-v2 §10.17), mounted once at the app's root and drawn over the place that
// keeps room for it: the hero on the curtain, the dock beside the stage or the island's badge. While
// Replay is open it plays the recording's dot instead of the live one.
export function PresenceLayer({ place: asked, provisional = false, ...now }: PresenceLayerProps) {
  const { feed, line } = useReplayPresence() ?? now;
  const place = useEntrance(asked, provisional);
  const reduced = useMediaQuery(REDUCED_MOTION);
  const frame = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLSpanElement>(null);
  const presence = useRef<Presence | null>(null);
  const live = place === "dock" || place === "badge";
  const idle = useIdle(live && feed.state === "idle", presence);
  const state: DotState = feed.state === "idle" ? idle : feed.state;
  const first = useRef({ state, control: feed.control, reducedMotion: reduced });

  useEffect(() => {
    if (!frame.current || !host.current) return;
    const p = new Presence(frame.current, host.current, first.current);
    presence.current = p;
    return () => {
      p.destroy();
      presence.current = null;
    };
  }, []);

  useEffect(() => presence.current?.setReducedMotion(reduced), [reduced]);
  useEffect(() => presence.current?.view.setState(state), [state]);
  useEffect(() => presence.current?.view.setControl(feed.control), [feed.control]);
  const fx = feed.focus?.x;
  const fy = feed.focus?.y;
  useEffect(() => {
    presence.current?.setFocus(fx === undefined || fy === undefined ? null : { x: fx, y: fy });
  }, [fx, fy]);
  useEffect(() => {
    if (line) presence.current?.view.say(sayMs(line));
  }, [line]);
  useEffect(() => {
    if (feed.dispatched) presence.current?.view.react("dispatch");
  }, [feed.dispatched]);
  useEffect(() => {
    if (feed.done) presence.current?.view.react("success");
  }, [feed.done]);
  useEffect(() => {
    if (feed.nod) presence.current?.view.react("acknowledged");
  }, [feed.nod]);

  useEffect(() => {
    const p = presence.current;
    if (!p) return;
    p.goTo(place);
    const again = () => p.goTo(place);
    const resized = () => p.follow(true);
    const moved = () => p.follow(false);
    const unsubscribe = onPlaces(again);
    window.addEventListener("resize", resized);
    document.addEventListener("transitionend", moved);
    return () => {
      unsubscribe();
      window.removeEventListener("resize", resized);
      document.removeEventListener("transitionend", moved);
    };
  }, [place]);

  return (
    <div className="presence" aria-hidden="true">
      <div
        ref={frame}
        className="presence-frame"
        data-place={place ?? undefined}
        data-attention={(feed.attention && place !== "badge") || undefined}
      >
        <span ref={host} className="dot" />
        <span className="presence-glyph">
          <Glyph />
        </span>
        <span className="presence-mark" />
      </div>
    </div>
  );
}

type Idle = "idle" | "listening" | "resting" | "dozing";

// What an idle dot does while the computer is on: it listens while the user types to it, rests
// after a minute without input and dozes after five; any input wakes it with a slow blink.
function useIdle(active: boolean, presence: { current: Presence | null }): Idle {
  const [phase, setPhase] = useState<Idle>("idle");
  const current = useRef(phase);
  current.current = phase;
  useEffect(() => {
    if (!active) {
      setPhase("idle");
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hiddenAt = 0;
    const typing = () => {
      const field = document.activeElement;
      if (!(field instanceof HTMLTextAreaElement) || !field.matches(COMPOSER)) return false;
      if (!field.value.trim()) return false;
      const rect = field.getBoundingClientRect();
      presence.current?.lookAtComposer({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      return true;
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setPhase("resting");
        timer = setTimeout(() => setPhase("dozing"), DOZING_MS - RESTING_MS);
      }, RESTING_MS);
    };
    let last = 0;
    const input = (event: Event) => {
      const asleep = current.current === "resting" || current.current === "dozing";
      const t = Date.now();
      // Pointer moves only need to reset the clock now and then.
      if (event.type === "pointermove" && !asleep && t - last < 1000) return;
      last = t;
      if (asleep) presence.current?.view.react("acknowledged");
      setPhase(typing() ? "listening" : "idle");
      schedule();
    };
    const visibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt && Date.now() - hiddenAt >= AWAY_MS)
        presence.current?.view.react("acknowledged");
      hiddenAt = 0;
    };
    const events = [
      "pointerdown",
      "pointermove",
      "keydown",
      "wheel",
      "input",
      "focusin",
      "focusout",
    ];
    for (const name of events) document.addEventListener(name, input, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    setPhase(typing() ? "listening" : "idle");
    schedule();
    return () => {
      clearTimeout(timer);
      for (const name of events) document.removeEventListener(name, input);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [active, presence]);
  return phase;
}
