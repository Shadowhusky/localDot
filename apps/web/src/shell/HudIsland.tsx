import { type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";
import { clock } from "../copy/format.ts";
import { PresenceSlot } from "../dot/PresenceSlot.tsx";
import type { HudAction, Status } from "../session/status.ts";
import { targetRingBox } from "../stage/geometry.ts";
import type { FieldMark } from "../stage/worker-protocol.ts";
import { Button } from "../ui/Button.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import type { IconName } from "../ui/icons.ts";
import { useMediaQuery } from "../ui/media.ts";
import { Presence } from "../ui/Presence.tsx";
import {
  decisionTop,
  type IslandShape,
  islandAttention,
  type PauseSlot,
  type TakeSlot,
} from "./island.ts";
import { HANDHELD } from "./layout.ts";
import "./hud.css";

type ComputerKind = Exclude<HudAction["kind"], "stop-task">;

const COMPUTER: Record<ComputerKind, { label: string; icon?: IconName }> = {
  start: { label: "Turn on", icon: "power" },
  stop: { label: "Shut down", icon: "power" },
  resume: { label: "Continue", icon: "play" },
  retry: { label: "Try again" },
};
const STOP_KEYS = ["Mod", "Shift", "."] as const;
// The decision the island grows into: at least this wide, its header the island's own row 2 px
// taller each way.
const DECISION_WIDTH = 480;
const HEADER_GROWTH = 2;
// The room a decision dropped under a field leaves at the foot of the page.
const PAGE_FOOT = 16;

// The fields dot will fill on the screen shown, in that screen's pixels.
export interface StageFields {
  screen: { w: number; h: number };
  marks: readonly FieldMark[];
}

export interface HudIslandProps {
  status: Status;
  shape: IslandShape;
  // dot's place while it can't sit beside the stage, as when a phone's keyboard is up.
  badge?: boolean;
  pause: PauseSlot;
  take: TakeSlot;
  onPause(): void;
  onContinue(): void;
  onStopTask(): void;
  onTake(): void;
  onComputer: Record<ComputerKind, () => void>;
  // What the island grows into while dot waits on the user; the row stays as its header.
  decision?: ReactNode;
  // Short notes that drop from the island, under it or under the decision it grew into.
  notices?: ReactNode;
  // Toasts hang from the island, or from the decision it grew into.
  ref?: RefObject<HTMLDivElement | null>;
  // A decision never covers the rings on these; it drops under them instead.
  fields?: StageFields;
}

// Status and the task's controls in one glass island hung on the stage's top edge. Every slot has a
// fixed width and keeps its place while dot thinks, acts and checks the screen; only a change of
// shape changes the island's width, and the glass behind it follows on a spring.
export function HudIsland({
  status,
  shape,
  badge = false,
  pause,
  take,
  onPause,
  onContinue,
  onStopTask,
  onTake,
  onComputer,
  decision,
  notices,
  ref,
  fields,
}: HudIslandProps) {
  const phone = useMediaQuery(HANDHELD);
  const own = useRef<HTMLDivElement>(null);
  const anchor = ref ?? own;
  const row = useRef<HTMLDivElement>(null);
  const plate = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const open = !!decision && shape === "task";
  // The card keeps what it last showed while it fades back into the island.
  const shown = useRef<ReactNode>(null);
  if (open) shown.current = decision;
  useLayoutEffect(() => {
    const glass = plate.current;
    if (!glass) return;
    // The first width is drawn as it is; only later changes travel.
    const settle = requestAnimationFrame(() => glass.setAttribute("data-settled", ""));
    return () => cancelAnimationFrame(settle);
  }, []);
  useLayoutEffect(() => {
    const content = row.current;
    const glass = plate.current;
    const root = anchor.current;
    if (!content || !glass || !root) return;
    const fit = () => {
      const grown = open ? card.current : null;
      if (!grown) {
        glass.style.width = `${content.offsetWidth}px`;
        glass.style.height = "";
        root.style.removeProperty("--_drop");
        root.style.removeProperty("--_lower");
        return;
      }
      const width = Math.max(content.offsetWidth, DECISION_WIDTH);
      const height = content.offsetHeight + HEADER_GROWTH * 2 + grown.offsetHeight;
      glass.style.width = `${width}px`;
      glass.style.height = `${height}px`;
      root.style.setProperty("--_card-w", `${width}px`);
      root.style.setProperty("--_drop", `${height - HEADER_GROWTH}px`);
      const stage = root.parentElement;
      if (!stage) return;
      const box = { w: stage.clientWidth, h: stage.clientHeight };
      const hung = -content.offsetHeight / 2 - HEADER_GROWTH;
      const top = decisionTop({
        hung,
        size: { w: width, h: height },
        stageW: box.w,
        rings:
          fields && box.w > 0 && box.h > 0
            ? fields.marks.map((mark) => targetRingBox(mark, fields.screen, box))
            : [],
        floor: window.innerHeight - stage.getBoundingClientRect().top - PAGE_FOOT,
      });
      if (top > hung) root.style.setProperty("--_lower", `${top - hung}px`);
      else root.style.removeProperty("--_lower");
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    if (open && card.current) observer.observe(card.current);
    if (open && root.parentElement) observer.observe(root.parentElement);
    return () => observer.disconnect();
  }, [open, anchor, fields]);

  const stop = status.actions.find((action) => action.kind === "stop-task");
  const computerActions = status.actions.filter(
    (action): action is HudAction & { kind: ComputerKind } => action.kind !== "stop-task",
  );
  const task = shape === "task";
  const control = phone ? 28 : 32;
  return (
    <div className="island-anchor" ref={anchor}>
      <div
        className="island"
        data-shape={shape}
        data-open={open || undefined}
        inert={shape === "hidden"}
      >
        <span className="island-plate" ref={plate} aria-hidden="true" />
        <div className="island-row" ref={row}>
          {badge && <PresenceSlot name="badge" className="island-badge" />}
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
              {status.countdownS !== null
                ? `in ${status.countdownS} s`
                : status.elapsedS === null
                  ? ""
                  : clock(status.elapsedS)}
            </span>
          )}
          <span className="island-controls">
            <span className="island-divider" aria-hidden="true" />
            {task && (
              <>
                <PauseButton
                  slot={pause}
                  size={control}
                  onPause={onPause}
                  onContinue={onContinue}
                />
                <IconButton
                  variant="glass"
                  size={control}
                  icon="stop"
                  label={stop?.busy ? "Stopping" : "Stop"}
                  kbd={STOP_KEYS}
                  data-testid="hud-stop-session"
                  disabledReason={
                    stop?.busy
                      ? "Stopping…"
                      : stop?.enabled
                        ? undefined
                        : "Reconnecting to the task…"
                  }
                  onClick={onStopTask}
                />
                <span className="island-divider" aria-hidden="true" />
              </>
            )}
            {(task || shape === "ready") &&
              (phone ? (
                <IconButton
                  variant={take.primary ? "primary" : "filled"}
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
          </span>
        </div>
        <Presence show={open}>
          <div className="island-card" ref={card}>
            {shown.current}
          </div>
        </Presence>
      </div>
      {notices && <div className="island-notices">{notices}</div>}
    </div>
  );
}

// The task's Pause, which becomes Continue while the task is paused, in one place.
export function PauseButton({
  slot,
  size = 32,
  variant = "glass",
  round = false,
  onPause,
  onContinue,
}: {
  slot: PauseSlot;
  size?: 28 | 32 | 44;
  variant?: "glass" | "filled";
  round?: boolean;
  onPause(): void;
  onContinue(): void;
}) {
  return slot.kind === "pause" ? (
    <IconButton
      variant={variant}
      round={round}
      size={size}
      icon="pause"
      label="Pause"
      disabledReason={slot.reason}
      onClick={onPause}
    />
  ) : (
    <IconButton
      variant={variant}
      round={round}
      size={size}
      icon="play"
      label="Continue"
      disabledReason={slot.reason}
      onClick={onContinue}
    />
  );
}
