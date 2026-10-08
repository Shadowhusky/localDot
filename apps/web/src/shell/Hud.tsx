import type { HudState } from "../cells/hud-state.ts";
import { Mascot } from "./Mascot.tsx";

export interface HudProps {
  hud: HudState & { control?: boolean; elapsedS?: number | null; stop?: boolean };
  onStart(): void;
  onStop(): void;
  onResume(): void;
  onStopSession(): void;
  onRetry(): void;
  stopping?: boolean;
  stopEnabled?: boolean;
}

export function Hud({
  hud,
  onStart,
  onStop,
  onStopSession,
  onResume,
  onRetry,
  stopping = false,
  stopEnabled = true,
}: HudProps) {
  return (
    <div className={hud.action.kind === "resume" && !hud.stop ? "hud paused" : "hud"}>
      <span className="st">
        <Mascot />
        <span data-testid="hud-status" role="status" aria-live="polite" aria-atomic="true">
          {hud.label}
        </span>
        {hud.elapsedS != null && (
          <span className="t num" data-testid="hud-elapsed" aria-live="off">
            {hud.elapsedS} s
          </span>
        )}
      </span>
      <button
        type="button"
        className="a"
        aria-disabled={
          (hud.stop ? !stopEnabled || stopping : !hud.action.enabled) ? true : undefined
        }
        aria-busy={stopping || undefined}
        data-testid={hud.stop ? "hud-stop-session" : undefined}
        onClick={() => {
          if (hud.stop) {
            if (stopEnabled && !stopping) onStopSession();
          } else if (hud.action.enabled) {
            if (hud.action.kind === "start") onStart();
            else if (hud.action.kind === "stop") onStop();
            else if (hud.action.kind === "resume") onResume();
            else onRetry();
          }
        }}
      >
        {(hud.stop || hud.action.kind === "stop") && <span className="sq" aria-hidden="true" />}
        {hud.stop
          ? stopping
            ? "Stopping…"
            : "Stop"
          : hud.action.kind === "start"
            ? "Turn on"
            : hud.action.kind === "stop"
              ? "Stop computer"
              : hud.action.kind === "resume"
                ? "Resume computer"
                : "Try again"}
      </button>
      {!hud.stop && hud.action.kind === "resume" && (
        <button
          type="button"
          className="a"
          aria-disabled={!hud.action.enabled ? true : undefined}
          onClick={() => {
            if (hud.action.enabled) onStop();
          }}
        >
          <span className="sq" aria-hidden="true" />
          Stop computer
        </button>
      )}
    </div>
  );
}
