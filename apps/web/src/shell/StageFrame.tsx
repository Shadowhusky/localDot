import { type ReactNode, type RefObject, useCallback } from "react";
import { registerPlace } from "../dot/places.ts";
import "./stage-frame.css";

// Who has the computer: nobody, dot (xenon) or the user (porcelain).
export type StageLight = "none" | "dot" | "you";

export interface StageFrameProps {
  light: StageLight;
  live: boolean;
  frozen: boolean;
  // The HUD island, in the strip over the stage's top edge.
  island?: ReactNode;
  // Covers the stage, or the stage and the band on a phone, while there is no picture to show.
  curtain?: ReactNode;
  // Under the stage: dot's place and its line.
  band?: ReactNode;
  // In the margin beside the stage, while a phone held sideways gives it the whole screen.
  side?: ReactNode;
  // The picture.
  children?: ReactNode;
  // The 16:10 box, which full screen moves.
  boxRef?: RefObject<HTMLDivElement | null>;
  // A double-click on the picture, while it is only watched.
  onPictureDoubleClick?(): void;
}

// The stage: one 16:10 box that never moves, with its rim and the light it spills on the floor
// always mounted and only fading, so who has the computer changes nothing but light.
export function StageFrame({
  light,
  live,
  frozen,
  island,
  curtain,
  band,
  side,
  children,
  boxRef,
  onPictureDoubleClick,
}: StageFrameProps) {
  const stageRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      if (boxRef) boxRef.current = element;
      const unregister = registerPlace("stage", element);
      return () => {
        unregister();
        if (boxRef) boxRef.current = null;
      };
    },
    [boxRef],
  );
  const picture = ["stage", live ? "lit" : "", frozen ? "frozen" : ""].filter(Boolean).join(" ");
  return (
    <div className="stage-frame" data-light={light}>
      <div className="stage-box" ref={stageRef}>
        <div className="stage-spill" aria-hidden="true">
          <i data-light="none" />
          <i data-light="dot" />
          <i data-light="you" />
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; F and the corner button are the keyboard's way */}
        <div className={picture} onDoubleClick={onPictureDoubleClick}>
          {children}
        </div>
        <div className="stage-rim" aria-hidden="true">
          <i data-light="dot" />
          <i data-light="you" />
        </div>
        {island}
      </div>
      <div className="stage-band">{band}</div>
      {side && <div className="stage-side">{side}</div>}
      {curtain && <div className="stage-curtain">{curtain}</div>}
    </div>
  );
}
