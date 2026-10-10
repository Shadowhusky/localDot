import type { ReactNode } from "react";
import type { HudAction } from "../session/status.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { PauseButton } from "./HudIsland.tsx";
import type { PauseSlot, TakeSlot } from "./island.ts";

const IDLE = "No task is running";

export interface FocusControlsProps {
  take: TakeSlot;
  // The task's Pause and Stop; without a task they stay in place, unavailable.
  pause: PauseSlot | null;
  stop: HudAction | undefined;
  onTake(): void;
  onPause(): void;
  onContinue(): void;
  onStop(): void;
  onLeave(): void;
  // While the user has the computer, what they work it with stands in for the task's controls.
  tools?: ReactNode;
}

// Focus mode's controls in the margin beside the picture (design-v2 §8.5): one column of 44 px
// buttons that never move, whatever the task does. Held upright, they line up under the picture,
// which turning the phone sideways makes bigger.
export function FocusControls({
  take,
  pause,
  stop,
  onTake,
  onPause,
  onContinue,
  onStop,
  onLeave,
  tools,
}: FocusControlsProps) {
  return (
    <div className="focus-side">
      <div className="focus-controls">
        {tools ?? (
          <>
            <IconButton
              variant={take.primary ? "primary" : "filled"}
              round
              size={44}
              icon="hand"
              label="Take control"
              disabledReason={take.reason}
              onClick={onTake}
            />
            {pause?.kind === "continue" && (
              <PauseButton
                slot={pause ?? { kind: "pause", reason: IDLE }}
                size={44}
                variant="filled"
                round
                onPause={onPause}
                onContinue={onContinue}
              />
            )}
            <IconButton
              variant="filled"
              round
              size={44}
              icon="stop"
              label={stop?.busy ? "Stopping" : "Stop"}
              disabledReason={
                !stop
                  ? IDLE
                  : stop.busy
                    ? "Stopping…"
                    : stop.enabled
                      ? undefined
                      : "Reconnecting to the task…"
              }
              onClick={onStop}
            />
          </>
        )}
        <IconButton
          variant="filled"
          round
          size={44}
          icon="shrink"
          label="Exit full screen"
          onClick={onLeave}
        />
      </div>
      <p className="focus-hint">Turn your phone sideways for a bigger picture.</p>
    </div>
  );
}
