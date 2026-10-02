import type { HudState } from "../cells/hud-state.ts";
import { Mascot } from "./Mascot.tsx";

export interface HudProps {
  hud: HudState & { control?: boolean; elapsedS?: number | null; stop?: boolean };
  onStart(): void;
  onStop(): void;
  onStopSession(): void;
  onRetry(): void;
}

export function Hud({ hud, onStart, onStop, onStopSession, onRetry }: HudProps) {
  return (
    <div className="hud" role="status" aria-live="polite">
      <span className="st">
        <Mascot />
        <span data-testid="hud-status">{hud.label}</span>
        {hud.elapsedS != null && (
          <span className="t num" data-testid="hud-elapsed">
            {hud.elapsedS} s
          </span>
        )}
      </span>
      <button
        type="button"
        className="a"
        aria-disabled={!hud.stop && !hud.action.enabled ? true : undefined}
        data-testid={hud.stop ? "hud-stop-session" : undefined}
        onClick={() => {
          if (hud.stop) onStopSession();
          else if (hud.action.enabled) {
            if (hud.action.kind === "start") onStart();
            else if (hud.action.kind === "stop") onStop();
            else onRetry();
          }
        }}
      >
        {(hud.stop || hud.action.kind === "stop") && <span className="sq" aria-hidden="true" />}
        {hud.stop
          ? "Stop"
          : hud.action.kind === "start"
            ? "Start computer"
            : hud.action.kind === "stop"
              ? "Stop computer"
              : "Try again"}
      </button>
    </div>
  );
}
