import type { ReactNode } from "react";
import type { HudState } from "../cells/hud-state.ts";
import { Caption } from "./Caption.tsx";
import { Hud } from "./Hud.tsx";

export interface StageColumnProps {
  hud: HudState;
  onStart(): void;
  onStop(): void;
  children?: ReactNode;
}

export function StageColumn({ hud, onStart, onStop, children }: StageColumnProps) {
  return (
    <main className="stage-col">
      <div className={hud.live ? "stage lit" : "stage"}>
        {children}
        <Hud hud={hud} onStart={onStart} onStop={onStop} />
      </div>
      <Caption text={hud.caption} />
    </main>
  );
}
