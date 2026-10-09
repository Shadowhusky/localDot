import type { HudAction, Status } from "../session/status.ts";
import { Mascot } from "./Mascot.tsx";

export interface HudProps {
  status: Status;
  onStart(): void;
  onStop(): void;
  onResume(): void;
  onStopSession(): void;
  onRetry(): void;
}

const LABELS: Record<HudAction["kind"], string> = {
  "stop-task": "Stop",
  start: "Turn on",
  stop: "Stop computer",
  resume: "Resume computer",
  retry: "Try again",
};

export function Hud({ status, onStart, onStop, onStopSession, onResume, onRetry }: HudProps) {
  const run: Record<HudAction["kind"], () => void> = {
    "stop-task": onStopSession,
    start: onStart,
    stop: onStop,
    resume: onResume,
    retry: onRetry,
  };
  // The first control stays the same element as its action changes, so focus stays on it.
  const button = (action: HudAction | undefined) =>
    action && (
      <button
        type="button"
        className="a"
        aria-disabled={action.enabled ? undefined : true}
        aria-busy={action.busy}
        data-testid={action.kind === "stop-task" ? "hud-stop-session" : undefined}
        onClick={() => {
          if (action.enabled) run[action.kind]();
        }}
      >
        {(action.kind === "stop-task" || action.kind === "stop") && (
          <span className="sq" aria-hidden="true" />
        )}
        {action.busy ? "Stopping…" : LABELS[action.kind]}
      </button>
    );
  return (
    <div className={status.actions[0]?.kind === "resume" ? "hud paused" : "hud"}>
      <span className="st">
        <Mascot state={status.dotPose} control={status.control} />
        <span data-testid="hud-status" role="status" aria-live="polite" aria-atomic="true">
          {status.label}
        </span>
        {status.elapsedS != null && (
          <span className="t num" data-testid="hud-elapsed" aria-live="off">
            {status.elapsedS} s
          </span>
        )}
        {status.countdownS != null && (
          <span className="t num" data-testid="hud-countdown" aria-live="off">
            in {status.countdownS} s
          </span>
        )}
      </span>
      {button(status.actions[0])}
      {button(status.actions[1])}
    </div>
  );
}
