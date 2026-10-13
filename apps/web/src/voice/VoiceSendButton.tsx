import { useCallback, useEffect, useId, useRef, useState } from "react";
import { IconButton, type IconButtonProps } from "../ui/IconButton.tsx";
import { joinIds } from "../ui/merge.ts";
import type { Voice } from "./useVoice.ts";

export const VOICE_HOLD_MS = 450;
const HINT_KEY = "localdot.voice-send-hint.v1";

// Tap retains Send/Stop. A deliberate hold starts a latched recording, so letting
// go cannot send the message or stop the task. The next tap finishes dictation.
export function VoiceSendButton({ voice, ...props }: IconButtonProps & { voice: Voice }) {
  const active = voice.state.phase !== "idle";
  const finishing = voice.state.phase === "finishing";
  const latest = useRef(voice);
  latest.current = voice;
  const held = useRef<{ id: number; x: number; y: number; timer: number } | null>(null);
  const consumed = useRef(false);
  const [hint, setHint] = useState(false);
  const hintId = useId();
  const clear = useCallback(() => {
    if (held.current) window.clearTimeout(held.current.timer);
    held.current = null;
  }, []);
  useEffect(() => clear, [clear]);
  useEffect(() => {
    if (!voice.enabled) return;
    try {
      if (localStorage.getItem(HINT_KEY)) return;
    } catch {
      /* A blocked store must not disable dictation. */
    }
    const show = window.setTimeout(() => {
      setHint(true);
      try {
        localStorage.setItem(HINT_KEY, "seen");
      } catch {
        /* Session-only hint. */
      }
    }, 1200);
    const hide = window.setTimeout(() => setHint(false), 6500);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [voice.enabled]);
  return (
    <span className="composer-send-wrap">
      {hint && !active && (
        <span className="composer-voice-hint" id={hintId} role="tooltip">
          Hold to speak
        </span>
      )}
      <IconButton
        {...props}
        type={active ? "button" : props.type}
        icon={active ? "check" : props.icon}
        label={active ? (finishing ? "Transcribing speech" : "Finish speaking") : props.label}
        disabledReason={
          active ? (finishing ? "Turning speech into text" : undefined) : props.disabledReason
        }
        aria-describedby={joinIds(props["aria-describedby"], hint && !active ? hintId : undefined)}
        style={{ ...props.style, touchAction: "none", WebkitTouchCallout: "none" }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          consumed.current = false;
          setHint(false);
          if (active || !voice.enabled) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          clear();
          held.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            timer: window.setTimeout(() => {
              if (!held.current || !latest.current.enabled) return;
              consumed.current = true;
              const at = performance.now();
              latest.current.send({ type: "press", at });
              latest.current.send({ type: "release", at });
            }, VOICE_HOLD_MS),
          };
        }}
        onPointerMove={(event) => {
          const press = held.current;
          if (!press || press.id !== event.pointerId || consumed.current) return;
          if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) {
            consumed.current = true;
            clear();
          }
        }}
        onPointerUp={clear}
        onPointerCancel={() => {
          consumed.current = true;
          clear();
          if (latest.current.state.phase !== "idle") latest.current.dismiss();
        }}
        onLostPointerCapture={clear}
        onClick={(event) => {
          if (consumed.current) {
            event.preventDefault();
            consumed.current = false;
            return;
          }
          if (active) {
            event.preventDefault();
            if (!finishing)
              voice.send({ type: voice.state.phase === "listening" ? "stop" : "cancel" });
            return;
          }
          props.onClick?.(event);
        }}
      />
    </span>
  );
}
