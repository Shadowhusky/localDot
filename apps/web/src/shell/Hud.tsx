import type { HudActionKind, HudState } from "../cells/hud-state.ts";
import { Mascot } from "./Mascot.tsx";

const LABELS: Record<HudActionKind, string> = {
  start: "Start computer",
  stop: "Stop computer",
  retry: "Try again",
};

// One button for the HUD's lifetime. A disabled one stays focusable (aria-disabled, not disabled),
// so focus is never dropped while a request is out.
export function Hud({ hud, onAction }: { hud: HudState; onAction(kind: HudActionKind): void }) {
  const { kind, enabled } = hud.action;
  return (
    <div className="hud">
      <span className="st">
        <Mascot />
        <span role="status" data-testid="hud-status">
          {hud.label}
        </span>
      </span>
      <button
        type="button"
        className="a"
        aria-disabled={enabled ? undefined : true}
        onClick={() => {
          if (enabled) onAction(kind);
        }}
      >
        {kind === "stop" && <span className="sq" aria-hidden="true" />}
        {LABELS[kind]}
      </button>
    </div>
  );
}
