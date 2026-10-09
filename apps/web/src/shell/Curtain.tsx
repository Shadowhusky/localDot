import type { ComputerOperationKind, ComputerOperationStep } from "@localdot/protocol";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { type ComputerPhase, type HudActionKind, NEEDS_FRESH_START } from "../cells/hud-state.ts";
import {
  expectedMsFor,
  type OperationClock,
  progressAt,
  type Timing,
} from "../cells/operation-clock.ts";
import { clock } from "../copy/format.ts";
import { PresenceSlot } from "../dot/PresenceSlot.tsx";
import type { HudAction } from "../session/status.ts";
import { Button } from "../ui/Button.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { FreshStartButton } from "./FreshStartButton.tsx";
import "./stage-frame.css";

type ComputerAction = HudAction & { kind: HudActionKind };

export interface CurtainProps {
  phase: ComputerPhase;
  // No computer has existed yet, so the first task is still ahead.
  first: boolean;
  // A Turn on is on its way.
  waking: boolean;
  // The computer is moving onto a new version, from its stop until it is ready again.
  updating?: boolean;
  // The computer's own words, for a failure.
  caption: string;
  // Why the last request was refused, in place of the usual words.
  notice?: string | null;
  action?: ComputerAction;
  onAction(): void;
  // A computer fenced after an unconfirmed step recovers on a fresh one.
  replace?: ReplaceAction;
  // A computer whose update can't be finished starts again clean, while that is going on too.
  freshStart?: FreshStartAction;
  // The start, update or stop the daemon is on, on this page's clock.
  operation?: OperationClock | null;
  // The computer came up: the progress fills before the curtain lifts.
  ready?: boolean;
  showDot: boolean;
}

export interface ReplaceAction {
  enabled: boolean;
  busy: boolean;
  // How the replacement is going, in place of the usual words.
  note?: string;
  run(): void;
}

export interface FreshStartAction {
  busy: boolean;
  // Why the last try didn't finish, in place of the usual words.
  note?: string;
  run(): void;
}

const STARTING = new Set<ComputerPhase>(["starting", "connecting"]);
const ATTEMPT = /attempt (\d+) of (\d+)/;

const STEP_WORDS: Partial<Record<ComputerOperationStep, string>> = {
  network: "Preparing the network…",
  desktop: "Starting the desktop…",
  ready: "Waiting for the desktop…",
  screen: "Connecting the screen…",
};

// The stage while there is no picture (design-v2 §11 A, B): dot asleep in a pool of light over one
// porcelain action. The column keeps its height whatever it says, so dot never moves on it.
export function Curtain({
  phase,
  first,
  waking,
  updating = false,
  caption,
  notice,
  action,
  onAction,
  replace,
  freshStart,
  operation,
  ready = false,
  showDot,
}: CurtainProps) {
  const phone = useMediaQuery(PHONE);
  const fresh = phase === "checking" ? undefined : freshStart;
  const recovering = !fresh && phase === "unavailable" && !!replace;
  const copy = fresh
    ? freshStartCopy(fresh)
    : recovering
      ? {
          title: "Your computer needs a fresh start",
          sub:
            replace.note ??
            "An earlier step couldn't be confirmed. A fresh computer starts clean; its old Downloads are kept.",
          progress: false,
          button: { label: "Replace computer" },
        }
      : curtainCopy(phase, { first, waking, updating, caption, notice, action });
  const enabled = recovering ? replace.enabled : action?.enabled;
  // A fresh start is its own long job, beside the old computer's stop and the new one's start.
  const timing = useTiming(!!copy?.progress, fresh ? null : operation, copy?.kind ?? "start");
  const now = useSecondTicks(timing?.since ?? 0, !!timing && !ready);
  // A ready computer whose screen is on its way is on the last step, whatever was said before.
  const step = phase === "connecting" ? "screen" : timing?.step;
  return (
    <section
      className="curtain"
      data-dot={showDot ? "" : undefined}
      aria-label={copy ? copy.title : "Your computer"}
    >
      {copy ? (
        <div className="curtain-col">
          {showDot && <PresenceSlot name="hero" className="curtain-hero" />}
          <h2 className="curtain-title">{copy.title}</h2>
          <p className="curtain-sub">
            {copy.clock && timing && (
              <>
                <span className="num">{clock((now - timing.since) / 1000)}</span>
                {" · "}
              </>
            )}
            {(copy.steps && step && STEP_WORDS[step]) || copy.sub}
          </p>
          <div className="curtain-act" data-progress={copy.progress || undefined}>
            <CurtainProgress timing={timing && { ...timing, step }} now={now} done={ready} />
            {fresh ? (
              <FreshStartButton
                variant="primary"
                size={phone ? "xl" : "lg"}
                className="curtain-button"
                busy={fresh.busy}
                aria-hidden={copy.progress || undefined}
                tabIndex={copy.progress ? -1 : undefined}
                run={fresh.run}
              />
            ) : (
              (action || recovering) &&
              copy.button && (
                <Button
                  variant="primary"
                  size={phone ? "xl" : "lg"}
                  icon={copy.button.icon}
                  className="curtain-button"
                  busy={recovering && replace.busy}
                  disabledReason={enabled ? undefined : "Wait a moment"}
                  aria-hidden={copy.progress || undefined}
                  tabIndex={copy.progress ? -1 : undefined}
                  onClick={copy.progress ? undefined : recovering ? replace.run : onAction}
                >
                  {copy.button.label}
                </Button>
              )
            )}
          </div>
        </div>
      ) : (
        // Nothing is known yet: dot wakes where it will sit, and no words that could turn out wrong.
        <div className="curtain-col" role="status">
          {showDot && <PresenceSlot name="hero" className="curtain-hero" />}
          <VisuallyHidden>Starting localDot</VisuallyHidden>
        </div>
      )}
    </section>
  );
}

interface Copy {
  title: string;
  sub: string;
  clock?: boolean;
  progress: boolean;
  // What is going on, for its expected length until the daemon says.
  kind?: ComputerOperationKind;
  // The step the computer is on says more than the usual words.
  steps?: boolean;
  button?: { label: string; icon?: "power" };
}

function freshStartCopy({ busy, note }: FreshStartAction): Copy {
  return busy
    ? {
        title: "Starting fresh",
        sub: "Setting up a clean computer. Your sign-ins stay.",
        clock: true,
        progress: true,
        kind: "first-start",
      }
    : {
        title: "Your computer needs a fresh start",
        sub: note ?? NEEDS_FRESH_START,
        progress: false,
      };
}

function curtainCopy(
  phase: ComputerPhase,
  {
    first,
    waking,
    updating,
    caption,
    notice,
    action,
  }: Pick<CurtainProps, "first" | "waking" | "updating" | "caption" | "notice" | "action">,
): Copy | null {
  const turnOn = { label: "Turn on", icon: "power" as const };
  if (phase === "checking") return null;
  if (updating && (STARTING.has(phase) || phase === "stopping"))
    return {
      title: "Updating your computer",
      sub: "Your files and sign-ins stay.",
      clock: true,
      progress: true,
      kind: "update",
      button: turnOn,
    };
  if (phase === "restarting") {
    const attempt = ATTEMPT.exec(caption);
    return {
      title: "Restarting your computer",
      sub: attempt ? `Attempt ${attempt[1]} of ${attempt[2]}` : "It stopped unexpectedly.",
      clock: true,
      progress: true,
      kind: "restart",
      button: turnOn,
    };
  }
  if (waking || STARTING.has(phase))
    return {
      title: "Starting your computer",
      sub: "The first start takes about a minute.",
      clock: true,
      progress: true,
      kind: first ? "first-start" : "start",
      steps: true,
      button: turnOn,
    };
  if (phase === "stopping")
    return {
      title: "Shutting down your computer",
      sub: "Your files are kept.",
      progress: true,
      kind: "stop",
      button: turnOn,
    };
  if (phase === "failed")
    return action?.kind === "stop"
      ? {
          title: "Your computer didn't shut down",
          sub: caption,
          progress: false,
          button: { label: "Shut down" },
        }
      : {
          title: "Couldn't start your computer",
          sub: caption,
          progress: false,
          button: { label: "Start again" },
        };
  if (phase === "unavailable")
    return {
      title: "Your computer isn't available",
      sub: caption,
      progress: false,
      button: action?.enabled ? { label: "Try again" } : undefined,
    };
  return {
    title: "Your computer is off",
    sub:
      notice ||
      (first
        ? "Turn it on to start your first task."
        : "Your files are kept. Turn it on to pick up where you left off."),
    progress: false,
    button: turnOn,
  };
}

// What the curtain counts from while it shows progress: the daemon's operation, the last one it
// had while the progress goes on, or, before the daemon has said, when the progress first showed.
function useTiming(
  on: boolean,
  operation: OperationClock | null | undefined,
  kind: ComputerOperationKind,
): Timing | null {
  const [held, setHeld] = useState<Timing | null>(null);
  const next = on
    ? (operation ?? held ?? { since: Date.now(), expectedMs: expectedMsFor(kind), kind })
    : null;
  if (next !== held) setHeld(next);
  return next;
}

const TICK_SLACK_MS = 15;

// This page's now, read again on each whole second since `since`, so every page counting from the
// same start turns its clock over at the same moment.
function useSecondTicks(since: number, on: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const into = (((Date.now() - since) % 1000) + 1000) % 1000;
      timer = setTimeout(
        () => {
          setTick((n) => n + 1);
          arm();
        },
        1000 - into + TICK_SLACK_MS,
      );
    };
    arm();
    return () => clearTimeout(timer);
  }, [since, on]);
  return Date.now();
}

// Moves on with the operation and never back; only the computer coming up fills it. Each time it
// shows again it starts where the operation is, without sweeping there.
function CurtainProgress({
  timing,
  now,
  done,
}: {
  timing: Timing | null;
  now: number;
  done: boolean;
}) {
  const shown = useRef({ on: false, run: 0, value: 0 });
  if (!!timing !== shown.current.on)
    shown.current = {
      on: !!timing,
      run: shown.current.run + (timing ? 1 : 0),
      value: timing ? 0 : shown.current.value,
    };
  if (timing)
    shown.current.value = Math.max(shown.current.value, done ? 1 : progressAt(timing, now));
  return (
    <span className="curtain-progress" aria-hidden="true">
      <i
        key={shown.current.run}
        data-done={(timing && done) || undefined}
        style={{ "--progress": shown.current.value } as CSSProperties}
      />
    </span>
  );
}
