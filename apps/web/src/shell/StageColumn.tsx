import type { ReactNode } from "react";
import { Caption } from "./Caption.tsx";
import { Hud, type HudProps } from "./Hud.tsx";

export interface StageColumnProps extends HudProps {
  control: boolean;
  children?: ReactNode;
}

export function StageColumn({
  hud,
  control,
  onStart,
  onStop,
  onStopSession,
  onRetry,
  children,
}: StageColumnProps) {
  const classes = ["stage", hud.live ? "lit" : "", control ? "control" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <main className="stage-col">
      <div className={classes}>
        {children}
        <Hud
          hud={hud}
          onStart={onStart}
          onStop={onStop}
          onStopSession={onStopSession}
          onRetry={onRetry}
        />
      </div>
      <Caption text={hud.caption} />
    </main>
  );
}
