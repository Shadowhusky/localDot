import type { ReactNode } from "react";
import type { HudActionKind, HudState } from "../cells/hud-state.ts";
import { Caption } from "./Caption.tsx";
import { Hud } from "./Hud.tsx";

export interface StageColumnProps {
  hud: HudState;
  onAction(kind: HudActionKind): void;
  children?: ReactNode;
}

export function StageColumn({ hud, onAction, children }: StageColumnProps) {
  return (
    <main className="stage-col">
      <div className={hud.live ? "stage lit" : "stage"}>
        {children}
        <Hud hud={hud} onAction={onAction} />
      </div>
      <Caption text={hud.caption} />
    </main>
  );
}
