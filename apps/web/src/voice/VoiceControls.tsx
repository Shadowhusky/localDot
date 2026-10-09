import { type ReactNode, useEffect, useRef } from "react";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { isApple } from "../ui/Kbd.tsx";
import { REDUCED_MOTION, useMediaQuery } from "../ui/media.ts";
import { awayFrom } from "./machine.ts";
import { HOLD_KEYS, type Voice } from "./useVoice.ts";
import { routeBlocked, routeLabel } from "./words.ts";

const now = () => performance.now();

// The mic in the composer: hold to talk, let go to put the words in the message, slide away to
// cancel; a tap keeps it listening until the next tap. While it listens, a halo behind it breathes
// with the voice.
export function VoiceButton({ voice, size }: { voice: Voice; size: 28 | 36 }) {
  const { state, route } = voice;
  const blocked = voice.enabled ? routeBlocked(route) : "Not available right now";
  const pointer = useRef<{ id: number; rect: DOMRect } | null>(null);
  const active = state.phase !== "idle";
  const away = (state.phase === "starting" || state.phase === "listening") && state.away;
  const latched = (state.phase === "starting" || state.phase === "listening") && !state.held;
  return (
    <span
      className="voice-mic"
      data-voice={active ? state.phase : undefined}
      data-away={away || undefined}
    >
      <span className="voice-mic-halo" aria-hidden="true" />
      <IconButton
        label={latched ? "Tap to finish" : "Hold to talk"}
        icon={away ? "x" : "mic"}
        size={size}
        round={size === 36}
        kbd={HOLD_KEYS(isApple())}
        disabledReason={blocked}
        aria-pressed={active && !away}
        // A held finger may wander: the page must not take the slide for a scroll and drop the turn.
        style={{ touchAction: "none", color: away ? "var(--color-danger-fg)" : undefined }}
        onPointerDown={(event) => {
          if (event.button !== 0 || blocked) return;
          // The field keeps its focus and a phone's keyboard stays as it was.
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          pointer.current = {
            id: event.pointerId,
            rect: event.currentTarget.getBoundingClientRect(),
          };
          voice.send({ type: "press", at: now() });
        }}
        onPointerMove={(event) => {
          const held = pointer.current;
          if (!held || held.id !== event.pointerId) return;
          voice.send({
            type: "away",
            away: awayFrom(held.rect, event.clientX, event.clientY, away),
          });
        }}
        onPointerUp={(event) => {
          if (pointer.current?.id !== event.pointerId) return;
          pointer.current = null;
          voice.send({ type: "release", at: now() });
        }}
        onPointerCancel={() => {
          if (!pointer.current) return;
          pointer.current = null;
          voice.send({ type: "cancel" });
        }}
        onKeyDown={(event) => {
          if ((event.key !== " " && event.key !== "Enter") || blocked) return;
          event.preventDefault();
          if (!event.repeat) voice.send({ type: "press", at: now() });
        }}
        onKeyUp={(event) => {
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          voice.send({ type: "release", at: now() });
        }}
        onContextMenu={(event) => event.preventDefault()}
      />
    </span>
  );
}

// Where the composer's hint sits: while the user talks, the time, a live waveform and where the
// words are made; after a turn that went wrong, one line on why. Otherwise what it held before.
export function VoiceStrip({ voice, children }: { voice: Voice; children?: ReactNode }) {
  const { state, notice, route } = voice;
  if (state.phase === "idle")
    return notice ? (
      <p className="voice-notice" role="status">
        <Icon name="circle-alert" size={12} />
        <span>{notice}</span>
      </p>
    ) : (
      children
    );
  const away = (state.phase === "starting" || state.phase === "listening") && state.away;
  const latched = (state.phase === "starting" || state.phase === "listening") && !state.held;
  return (
    <div className="voice-strip" data-phase={state.phase} data-away={away || undefined}>
      {latched && (
        <IconButton
          className="voice-cancel"
          label="Cancel"
          icon="x"
          size={24}
          kbd={["Escape"]}
          onClick={() => voice.send({ type: "cancel" })}
        />
      )}
      <Waveform voice={voice} since={state.phase === "listening" ? state.since : null} />
      <span className="voice-tail">{away ? "Let go to cancel" : routeLabel(route)}</span>
    </div>
  );
}

const PITCH = 5;
const BAR = 3;
const SAMPLE_MS = 60;

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Bars scrolling in from the right, one per beat of the mic's level, the newest brightest. While
// the words are written down, a light passes along them. It draws straight to the canvas and the
// clock, so nothing renders per frame.
function Waveform({ voice, since }: { voice: Voice; since: number | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const reduced = useMediaQuery(REDUCED_MOTION);
  const level = useRef(voice.level);
  level.current = voice.level;
  // Kept across the turn's phases, so the bars freeze in place when the user lets go.
  const levels = useRef<number[]>([]);
  const finishing = voice.state.phase === "finishing";
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const card = element.closest<HTMLElement>(".composer-card");
    const color = getComputedStyle(element).color;
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = 0;
    let shown = "";
    const size = () => {
      const ratio = window.devicePixelRatio || 1;
      width = element.clientWidth;
      height = element.clientHeight;
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const resize = new ResizeObserver(size);
    resize.observe(element);
    size();
    const draw = (t: number) => {
      const count = Math.max(1, Math.floor(width / PITCH));
      if (!finishing && t - last >= SAMPLE_MS) {
        last = t;
        const heard = level.current();
        const value = heard < 0 ? 0.1 + 0.06 * Math.sin(t / 220) : heard;
        levels.current = [...levels.current, value].slice(-count);
        card?.style.setProperty("--_level", value.toFixed(3));
      }
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      const sweep = ((t % 1400) / 1400) * (count + 8) - 4;
      const bars = levels.current;
      bars.forEach((value, i) => {
        const slot = count - bars.length + i;
        const bar = Math.max(BAR, value * height);
        const age = (i + 1) / bars.length;
        let alpha = 0.28 + 0.72 * age ** 0.7;
        if (finishing)
          alpha = reduced ? 0.45 : 0.3 + 0.7 * Math.max(0, 1 - Math.abs(slot - sweep) / 5);
        context.globalAlpha = alpha;
        context.beginPath();
        context.roundRect(slot * PITCH, (height - bar) / 2, BAR, bar, BAR / 2);
        context.fill();
      });
      context.globalAlpha = 1;
      if (time.current && since !== null) {
        const text = clock(performance.now() - since);
        if (text !== shown) time.current.textContent = shown = text;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      card?.style.removeProperty("--_level");
    };
  }, [finishing, reduced, since]);
  return (
    <>
      <span ref={time} className="voice-time num" aria-hidden="true">
        0:00
      </span>
      <canvas ref={canvas} className="voice-wave" />
    </>
  );
}
