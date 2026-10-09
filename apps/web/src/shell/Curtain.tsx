import { useEffect, useState } from "react";
import type { ComputerPhase, HudActionKind } from "../cells/hud-state.ts";
import { clock } from "../copy/format.ts";
import { PresenceSlot } from "../dot/PresenceSlot.tsx";
import type { HudAction } from "../session/status.ts";
import { Button } from "../ui/Button.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import "./stage-frame.css";

type ComputerAction = HudAction & { kind: HudActionKind };

export interface CurtainProps {
  phase: ComputerPhase;
  // No computer has existed yet, so the first task is still ahead.
  first: boolean;
  // A Turn on is on its way.
  waking: boolean;
  // The computer's own words, for a failure.
  caption: string;
  // Why the last request was refused, in place of the usual words.
  notice?: string | null;
  action?: ComputerAction;
  onAction(): void;
  showDot: boolean;
}

const STARTING = new Set<ComputerPhase>(["starting", "connecting"]);
const ATTEMPT = /attempt (\d+) of (\d+)/;

// The stage while there is no picture (design-v2 §11 A, B): dot asleep in a pool of light over one
// porcelain action. The column keeps its height whatever it says, so dot never moves on it.
export function Curtain({
  phase,
  first,
  waking,
  caption,
  notice,
  action,
  onAction,
  showDot,
}: CurtainProps) {
  const phone = useMediaQuery(PHONE);
  const copy = curtainCopy(phase, { first, waking, caption, notice, action });
  return (
    <section
      className="curtain"
      data-dot={showDot ? "" : undefined}
      aria-label={copy ? copy.title : "Your computer"}
    >
      {copy && (
        <div className="curtain-col">
          {showDot && <PresenceSlot name="hero" className="curtain-hero" />}
          <h2 className="curtain-title">{copy.title}</h2>
          <p className="curtain-sub">
            {copy.clock && (
              <>
                <StartClock />
                {" · "}
              </>
            )}
            {copy.sub}
          </p>
          <div className="curtain-act" data-progress={copy.progress || undefined}>
            <span className="curtain-progress" aria-hidden="true">
              <i />
            </span>
            {action && copy.button && (
              <Button
                variant="primary"
                size={phone ? "xl" : "lg"}
                icon={copy.button.icon}
                className="curtain-button"
                disabledReason={action.enabled ? undefined : "Wait a moment"}
                aria-hidden={copy.progress || undefined}
                tabIndex={copy.progress ? -1 : undefined}
                onClick={copy.progress ? undefined : onAction}
              >
                {copy.button.label}
              </Button>
            )}
          </div>
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
  button?: { label: string; icon?: "power" };
}

function curtainCopy(
  phase: ComputerPhase,
  {
    first,
    waking,
    caption,
    notice,
    action,
  }: Pick<CurtainProps, "first" | "waking" | "caption" | "notice" | "action">,
): Copy | null {
  const turnOn = { label: "Turn on", icon: "power" as const };
  if (phase === "checking") return null;
  if (phase === "restarting") {
    const attempt = ATTEMPT.exec(caption);
    return {
      title: "Restarting your computer",
      sub: attempt ? `Attempt ${attempt[1]} of ${attempt[2]}` : "It stopped unexpectedly.",
      clock: true,
      progress: true,
      button: turnOn,
    };
  }
  if (waking || STARTING.has(phase))
    return {
      title: "Starting your computer",
      sub: "The first start takes about a minute.",
      clock: true,
      progress: true,
      button: turnOn,
    };
  if (phase === "stopping")
    return {
      title: "Shutting down your computer",
      sub: "Your files are kept.",
      progress: true,
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

// How long the computer has been starting, from when this page saw it start.
function StartClock() {
  const [since] = useState(Date.now);
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="num">{clock((now - since) / 1000)}</span>;
}
