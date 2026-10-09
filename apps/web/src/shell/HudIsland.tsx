import { useLayoutEffect, useRef } from "react";
import { clock } from "../copy/format.ts";
import type { HudAction, Status } from "../session/status.ts";
import { Button } from "../ui/Button.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import type { IconName } from "../ui/icons.ts";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { type IslandShape, islandAttention, type PauseSlot, type TakeSlot } from "./island.ts";
import "./hud.css";

type ComputerKind = Exclude<HudAction["kind"], "stop-task">;

const COMPUTER: Record<ComputerKind, { label: string; icon?: IconName }> = {
  start: { label: "Turn on", icon: "power" },
  stop: { label: "Shut down", icon: "power" },
  resume: { label: "Continue", icon: "play" },
  retry: { label: "Try again" },
};
const STOP_KEYS = ["Mod", "Shift", "."] as const;

export interface HudIslandProps {
  status: Status;
  shape: IslandShape;
  pause: PauseSlot;
  take: TakeSlot;
  onPause(): void;
  onContinue(): void;
  onStopTask(): void;
  onTake(): void;
  onComputer: Record<ComputerKind, () => void>;
}

// Status and the task's controls in one glass island hung on the stage's top edge. Every slot has a
// fixed width and keeps its place while dot thinks, acts and checks the screen; only a change of
// shape changes the island's width, and the glass behind it follows on a spring.
export function HudIsland({
  status,
  shape,
  pause,
  take,
  onPause,
  onContinue,
  onStopTask,
  onTake,
  onComputer,
}: HudIslandProps) {
  const phone = useMediaQuery(PHONE);
  const row = useRef<HTMLDivElement>(null);
  const plate = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const content = row.current;
    const glass = plate.current;
    if (!content || !glass) return;
    const fit = () => {
      glass.style.width = `${content.offsetWidth}px`;
    };
    fit();
    // The first width is drawn as it is; only later changes travel.
    const settle = requestAnimationFrame(() => glass.setAttribute("data-settled", ""));
    if (typeof ResizeObserver === "undefined") return () => cancelAnimationFrame(settle);
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    return () => {
      cancelAnimationFrame(settle);
      observer.disconnect();
    };
  }, []);

  const stop = status.actions.find((action) => action.kind === "stop-task");
  const computerActions = status.actions.filter(
    (action): action is HudAction & { kind: ComputerKind } => action.kind !== "stop-task",
  );
  const task = shape === "task";
  const control = phone ? 28 : 32;
  return (
    <div className="island" data-shape={shape} inert={shape === "hidden"}>
      <span className="island-plate" ref={plate} aria-hidden="true" />
      <div className="island-row" ref={row}>
        <span className="island-label">
          {islandAttention(status) && <span className="island-attention" aria-hidden="true" />}
          <span
            className="island-label-text"
            data-testid="hud-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span key={status.label}>{status.label}</span>
          </span>
        </span>
        {task && (
          <span className="island-elapsed num" data-testid="hud-elapsed" aria-live="off">
            {status.elapsedS === null ? "" : clock(status.elapsedS)}
          </span>
        )}
        <span className="island-divider" aria-hidden="true" />
        {task && (
          <>
            <PauseButton slot={pause} size={control} onPause={onPause} onContinue={onContinue} />
            <IconButton
              variant="glass"
              size={control}
              icon="stop"
              label={stop?.busy ? "Stopping" : "Stop"}
              kbd={STOP_KEYS}
              data-testid="hud-stop-session"
              disabledReason={
                stop?.busy ? "Stopping…" : stop?.enabled ? undefined : "Reconnecting to the task…"
              }
              onClick={onStopTask}
            />
            <span className="island-divider" aria-hidden="true" />
          </>
        )}
        {(task || shape === "ready") &&
          (phone && !take.primary ? (
            <IconButton
              variant="filled"
              round
              size={28}
              icon="hand"
              label="Take control"
              disabledReason={take.reason}
              onClick={onTake}
            />
          ) : (
            <Button
              variant={take.primary ? "primary" : "glass"}
              round
              size={phone ? "sm" : "md"}
              icon="hand"
              disabledReason={take.reason}
              onClick={onTake}
            >
              Take control
            </Button>
          ))}
        {shape === "computer" &&
          computerActions.map((action) => (
            <Button
              key={action.kind}
              className="island-action"
              variant="glass"
              round
              size={phone ? "sm" : "md"}
              icon={COMPUTER[action.kind].icon}
              disabledReason={action.enabled ? undefined : "Wait a moment"}
              onClick={onComputer[action.kind]}
            >
              {COMPUTER[action.kind].label}
            </Button>
          ))}
      </div>
    </div>
  );
}

// The task's Pause, which becomes Continue while the task is paused, in one place.
export function PauseButton({
  slot,
  size = 32,
  onPause,
  onContinue,
}: {
  slot: PauseSlot;
  size?: 28 | 32;
  onPause(): void;
  onContinue(): void;
}) {
  return slot.kind === "pause" ? (
    <IconButton
      variant="glass"
      size={size}
      icon="pause"
      label="Pause"
      disabledReason={slot.reason}
      onClick={onPause}
    />
  ) : (
    <IconButton
      variant="glass"
      size={size}
      icon="play"
      label="Continue"
      disabledReason={slot.reason}
      onClick={onContinue}
    />
  );
}
