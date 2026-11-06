import type { ReactNode } from "react";
import { Button } from "../ui/Button.tsx";
import "../ui/phone-layout.css";

export interface DotStripProps {
  // dot at work stays at the foot while the thread scrolls; at rest it scrolls with the thread.
  live: boolean;
  // Minimal mode: dot has gone into the ⋯ menu.
  hidden: boolean;
  // dot and its one sentence.
  band: ReactNode;
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

// The foot of the thread: one dot, one sentence and, while this task has it, the computer.
export function DotStrip({ live, hidden, band, thumb, time }: DotStripProps) {
  return (
    <div className="dot-strip" data-live={live || undefined} data-hidden={hidden || undefined}>
      <div className="dot-strip-clip" inert={hidden}>
        <div className="dot-strip-row">
          {band}
          {thumb ? (
            <Button
              variant="quiet"
              className="phone-thumb"
              data-light={thumb.light}
              aria-label="Open the computer"
              onClick={thumb.onOpen}
            >
              <span ref={thumb.slotRef} className="phone-thumb-slot" />
              <span className="phone-thumb-rim" aria-hidden="true" />
              {thumb.time && <span className="phone-thumb-time num">{thumb.time}</span>}
            </Button>
          ) : (
            time && <span className="dot-strip-time num">{time}</span>
          )}
        </div>
      </div>
    </div>
  );
}
