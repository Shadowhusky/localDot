import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef } from "react";
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
  liftOverScrim,
  type PauseSlot,
  type TakeSlot,
} from "./island.ts";
import { HANDHELD } from "./layout.ts";
import "./hud.css";

type ComputerKind = Exclude<HudAction["kind"], "stop-task">;

const COMPUTER: Record<ComputerKind, { label: string; icon?: IconName }> = {
  start: { label: "Turn on", icon: "power" },
  stop: { label: "Shut down", icon: "power" },
  resume: { label: "Resume", icon: "play" },
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
  // In Take control's place while the user has the computer.
  handBack?: { reason?: string; busy?: boolean };
  onPause(): void;
  onContinue(): void;
  onStopTask(): void;
  onTake(): void;
  onHandBack?(): void;
  onComputer: Record<ComputerKind, () => void>;
  // What the island grows into while dot waits on the user; the row stays as its header.
  decision?: ReactNode;
  // Short notes that drop from the island, under it or under the decision it grew into.
  notices?: ReactNode;
  // While the user has the computer the island rises into the top bar, where the bar has room.
  rise?: boolean;
  // The stage fills the screen: the island sits inside the picture's top edge, Take control is an
  // icon and the way out of full screen follows it.
  full?: boolean;
  onExitFull?(): void;
  // The width of the island's row, as it changes.
  onRowWidth?(width: number): void;
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
  handBack = {},
  onPause,
  onContinue,
  onStopTask,
  onTake,
  onHandBack,
  onComputer,
  decision,
  notices,
  rise = false,
  full = false,
  onExitFull,
  onRowWidth,
  ref,
  fields,
}: HudIslandProps) {
  const phone = useMediaQuery(HANDHELD);
  const own = useRef<HTMLDivElement>(null);
  const anchor = ref ?? own;
  const row = useRef<HTMLDivElement>(null);
  const plate = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const rowWidth = useRef(onRowWidth);
  rowWidth.current = onRowWidth;
  const open = !!decision && shape === "task";
  useLift(anchor, plate);
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
      rowWidth.current?.(content.offsetWidth);
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
  const yours = shape === "control";
  const task = shape === "task" || yours;
  const control = phone ? 28 : 32;
  // A phone keeps Hand back in its toolbar, so its island ends at Stop.
  const handSlot = !(yours && phone);
  return (
    <div
      className="island-anchor"
      ref={anchor}
      data-risen={(yours && rise && !full) || undefined}
      data-full={full || undefined}
    >
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
                {handSlot && !(full && !yours) && (
                  <span className="island-divider" aria-hidden="true" />
                )}
              </>
            )}
            {yours && handSlot && (
              <Button
                variant="primary"
                round
                size="md"
                icon="hand-back"
                busy={handBack.busy}
                disabledReason={handBack.reason}
                onClick={onHandBack}
              >
                Hand back
              </Button>
            )}
            {(shape === "task" || shape === "ready") &&
              (phone || full ? (
                <IconButton
                  variant={take.primary ? "primary" : full ? "glass" : "filled"}
                  round
                  size={control}
                  icon="hand"
                  label="Take control"
                  aria-busy={take.busy || undefined}
                  disabledReason={take.reason}
                  onClick={take.busy ? undefined : onTake}
                />
              ) : (
                <Button
                  variant={take.primary ? "primary" : "glass"}
                  round
                  size="md"
                  icon="hand"
                  busy={take.busy}
                  disabledReason={take.reason}
                  onClick={onTake}
                >
                  Take control
                </Button>
              ))}
            {shape === "computer" &&
              computerActions.map((action) => {
                const { label, icon } = COMPUTER[action.kind];
                const reason = action.enabled ? undefined : "Wait a moment";
                // A phone's island is one short line: its buttons are glyphs, as Take control is.
                return phone && icon ? (
                  <IconButton
                    key={action.kind}
                    className="island-action"
                    variant="glass"
                    round
                    size={control}
                    icon={icon}
                    label={label}
                    disabledReason={reason}
                    onClick={onComputer[action.kind]}
                  />
                ) : (
                  <Button
                    key={action.kind}
                    className="island-action"
                    variant="glass"
                    round
                    size={phone ? "sm" : "md"}
                    icon={icon}
                    disabledReason={reason}
                    onClick={onComputer[action.kind]}
                  >
                    {label}
                  </Button>
                );
              })}
            {full && (
              <IconButton
                variant="glass"
                size={control}
                icon="shrink"
                label="Exit full screen"
                kbd={["Escape"]}
                onClick={onExitFull}
              />
            )}
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

// Overlays open in their own layers at the end of the page; while one has a scrim, the island is
// marked to rise over it.
function useLift(anchor: RefObject<HTMLElement | null>, plate: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = anchor.current;
    if (!root || typeof MutationObserver === "undefined") return;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const layers = [...document.body.children].filter(
          (layer) => layer.matches(".ui-layer") && !layer.hasAttribute("data-closing"),
        );
        const scrim = layers.some((layer) => layer.querySelector(":scope > .ui-scrim"));
        const sheets = layers.flatMap((layer) =>
          [...layer.querySelectorAll(":scope > .ui-sheet")].map((sheet) =>
            sheet.getBoundingClientRect(),
          ),
        );
        const island = plate.current?.getBoundingClientRect();
        root.toggleAttribute("data-lifted", !!island && liftOverScrim(scrim, island, sheets));
      });
    };
    const added = new MutationObserver(check);
    added.observe(document.body, { childList: true });
    const closing = new MutationObserver(check);
    closing.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-closing"],
    });
    // A sheet slides into its place, and the island changes shape.
    document.addEventListener("transitionend", check);
    window.addEventListener("resize", check);
    check();
    return () => {
      cancelAnimationFrame(frame);
      added.disconnect();
      closing.disconnect();
      document.removeEventListener("transitionend", check);
      window.removeEventListener("resize", check);
    };
  }, [anchor, plate]);
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
