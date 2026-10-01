import type { HudState } from "../cells/hud-state.ts";
import { Mascot } from "./Mascot.tsx";

export function Hud({ hud, onStart, onStop }: { hud: HudState; onStart(): void; onStop(): void }) {
  return (
    <div className="hud">
      <span className="st">
        <Mascot />
        <span role="status" data-testid="hud-status">
          {hud.label}
        </span>
      </span>
      <span className="acts">
        {hud.action === "start" && (
          <button type="button" className="a" onClick={onStart}>
            Start computer
          </button>
        )}
        {hud.action === "stop" && (
          <button type="button" className="a" onClick={onStop}>
            <span className="sq" aria-hidden="true" />
            Stop computer
          </button>
        )}
      </span>
    </div>
  );
}
