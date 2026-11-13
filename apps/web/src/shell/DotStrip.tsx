import type { ReactNode } from "react";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import "../ui/phone-layout.css";

export interface DotStripProps {
  // dot at work stays at the foot while the thread scrolls; at rest it scrolls with the thread.
  live: boolean;
  // dot is working now, not waiting on the user or done: what the typing bubble says.
  working: boolean;
  // Minimal mode: dot has gone into the ⋯ menu.
  hidden: boolean;
  // dot and its one sentence.
  band: ReactNode;
  // What dot is doing, said in a typing bubble while dot itself is hidden.
  status?: ReactNode;
  // This task holds the computer: its picture, a tap from the computer screen.
  thumb?: {
    light: "dot" | "you" | "none";
    time?: ReactNode;
    slotRef(element: HTMLElement | null): void;
    onOpen(): void;
  };
  // How long it has run, while it runs without the computer.
  time?: ReactNode;
}

// The foot of the thread: one dot, one sentence and, while this task has it, the computer. With dot
// hidden, a task at work still shows it is going on, as a messenger shows the other side typing.
export function DotStrip({ live, working, hidden, band, status, thumb, time }: DotStripProps) {
  const typing = hidden && live && working && !!status;
  const away = hidden && !typing;
  return (
    <div
      className="dot-strip"
      data-live={live || undefined}
      data-hidden={away || undefined}
      data-typing={typing || undefined}
    >
      <div className="dot-strip-clip" inert={away}>
        <div className="dot-strip-row">
          {typing ? (
            <div className="dot-typing" role="status">
              <span className="dot-typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="dot-typing-text">{status}</span>
            </div>
          ) : (
            band
          )}
          {thumb ? (
            <Button
              variant="quiet"
              className="phone-thumb"
              data-light={thumb.light}
              aria-label={t`Open the computer`}
              onClick={thumb.onOpen}
            >
              <span ref={thumb.slotRef} className="phone-thumb-slot" />
              <span className="phone-thumb-rim" aria-hidden="true" />
              {thumb.time && <span className="phone-thumb-time num">{thumb.time}</span>}
            </Button>
          ) : (
            time && !typing && <span className="dot-strip-time num">{time}</span>
          )}
        </div>
      </div>
    </div>
  );
}
