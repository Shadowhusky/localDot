import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { isApple } from "../ui/Kbd.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { changeVoicePrefs } from "./prefs.ts";
import { HOLD_KEYS, type Voice } from "./useVoice.ts";

// Tap to dictate; Stop keeps the words in the draft. Sending is a separate action.
export function VoiceButton({ voice }: { voice: Voice }) {
  const { phase } = voice.state;
  const active = phase !== "idle";
  const busy = phase === "starting" || phase === "finishing";
  return (
    <span className="voice-mic" data-phase={phase}>
      <IconButton
        label={
          phase === "finishing"
            ? "Transcribing speech"
            : phase === "starting"
              ? "Starting microphone"
              : active
                ? "Stop recording"
                : "Start voice input"
        }
        icon={active ? "stop" : "mic"}
        size={32}
        round
        variant={active ? "filled" : "quiet"}
        kbd={active ? undefined : HOLD_KEYS(isApple())}
        disabledReason={
          !voice.enabled
            ? "Not available right now"
            : busy
              ? phase === "starting"
                ? "Starting microphone…"
                : "Turning speech into text…"
              : undefined
        }
        aria-busy={busy || undefined}
        onPointerDown={(event) => {
          if (event.button === 0) event.preventDefault();
        }}
        onClick={() => {
          if (active) void voice.finish();
          else {
            const at = performance.now();
            voice.send({ type: "press", at });
            voice.send({ type: "release", at });
          }
        }}
      />
      {busy && <Spinner className="voice-spinner" />}
    </span>
  );
}

// The recording row keeps Cancel, Stop and Send independently reachable.
export function VoiceStrip({ voice, children }: { voice: Voice; children?: ReactNode }) {
  const { state, notice, route } = voice;
  if (state.phase === "idle")
    return notice ? (
      <p className="voice-notice" role="status">
        <Icon name="circle-alert" size={12} />
        <span>{notice}</span>
        {route.kind === "none" && route.why === "online-off" && (
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              changeVoicePrefs({ online: true });
              voice.dismiss();
            }}
          >
            Enable online speech
          </Button>
        )}
        <IconButton label="Dismiss voice notice" icon="x" size={24} onClick={voice.dismiss} />
      </p>
    ) : (
      children
    );
  return (
    <div className="voice-strip" data-phase={state.phase}>
      <IconButton
        className="voice-cancel"
        label="Cancel recording"
        icon="x"
        size={32}
        round
        variant="filled"
        kbd={["Escape"]}
        onPointerDown={(event) => {
          if (event.button === 0) event.preventDefault();
        }}
        onClick={voice.dismiss}
      />
      {state.phase === "listening" ? (
        <Waveform voice={voice} since={state.since} />
      ) : (
        <span className="voice-status" role="status">
          {state.phase === "finishing" ? "Transcribing…" : "Starting microphone…"}
        </span>
      )}
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
// recording, it draws straight to the canvas and the
// clock, so nothing renders per frame.
function Waveform({ voice, since }: { voice: Voice; since: number | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const level = useRef(voice.level);
  level.current = voice.level;
  // The most recent microphone levels, sampled without React renders.
  const levels = useRef<number[]>([]);
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
      if (t - last >= SAMPLE_MS) {
        last = t;
        const heard = level.current();
        const value = heard < 0 ? 0 : heard;
        levels.current = [...levels.current, value].slice(-count);
        card?.style.setProperty("--_level", value.toFixed(3));
      }
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      const bars = levels.current;
      bars.forEach((value, i) => {
        const slot = count - bars.length + i;
        const bar = Math.max(BAR, value * height);
        const age = (i + 1) / bars.length;
        const alpha = 0.28 + 0.72 * age ** 0.7;
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
  }, [since]);
  return (
    <>
      <span ref={time} className="voice-time num" aria-hidden="true">
        0:00
      </span>
      <canvas ref={canvas} className="voice-wave" />
    </>
  );
}
