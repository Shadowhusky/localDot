import type { ReactNode } from "react";
import { Caption } from "./Caption.tsx";
import { Hud, type HudProps } from "./Hud.tsx";

export interface StageColumnProps extends HudProps {
  control: boolean;
  children?: ReactNode;
  showHud?: boolean;
  after?: ReactNode;
}

export function StageColumn({
  hud,
  control,
  onStart,
  onStop,
  onStopSession,
  onResume,
  onRetry,
  children,
  showHud = true,
  after,
}: StageColumnProps) {
  const classes = [
    "stage",
    hud.live ? "lit" : "",
    hud.paused ? "frozen" : "",
    control ? "control" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <main className={after ? "stage-col manual-column" : "stage-col"}>
      <div className={classes}>
        {children}
        {showHud && (
          <Hud
            hud={hud}
            onStart={onStart}
            onStop={onStop}
            onStopSession={onStopSession}
            onResume={onResume}
            onRetry={onRetry}
          />
        )}
      </div>
      <Caption text={hud.caption} />
      {after}
    </main>
  );
}
