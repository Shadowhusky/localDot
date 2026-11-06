import { useEffect, useRef } from "react";
import { Button } from "../ui/Button.tsx";
import { showToast } from "../ui/Toast.tsx";
import { useTooltip } from "../ui/Tooltip.tsx";
import "../ui/desktop-bar.css";
import type { StageFront } from "./useStageFront.ts";

// What the one desktop can't do, as the web browser's window is kept apart from it.
export const APART_NOTE =
  "The web browser runs apart from the desktop: copied text and drags don't cross between them.";

// Said once a page, the first time the user's own hands cross from one side to the other.
let told = false;
export function sayApart(): void {
  if (told) return;
  told = true;
  showToast({ id: "stage-apart", title: APART_NOTE });
}

export function browserEntryLabel(front: StageFront): string {
  if (front.screen === "browser") return "Minimise the web browser";
  return front.dot === "browser"
    ? "Show the web browser, where dot is working"
    : "Show the web browser";
}

// The web browser's entry on the desktop's menu bar, as a taskbar's: it shows the window, or
// minimises it and leaves the desktop in front.
export function BrowserEntry({ front, holding }: { front: StageFront; holding: boolean }) {
  const open = front.screen === "browser";
  const label = browserEntryLabel(front);
  const crossed = useRef(front.screen);
  useEffect(() => {
    if (crossed.current === front.screen) return;
    crossed.current = front.screen;
    if (holding) sayApart();
  }, [front.screen, holding]);
  useEffect(() => {
    if (front.problem) showToast({ id: "screen", title: front.problem, tone: "danger" });
  }, [front.problem]);
  const { triggerProps, tooltip } = useTooltip({ content: label });
  return (
    <div className="desktop-bar">
      <div className="desktop-bar-screen">
        <Button
          {...triggerProps.handlers}
          className="desktop-bar-browser"
          variant="quiet"
          size="sm"
          icon="globe"
          aria-label={label}
          aria-description={APART_NOTE}
          data-open={open || undefined}
          data-dot={!open && front.dot === "browser" ? "" : undefined}
          // Keys stay with the computer's keyboard field while a pointer uses the entry.
          onMouseDown={(event) => event.preventDefault()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={() => front.pick(open ? "desktop" : "browser")}
        >
          <span className="desktop-bar-label">Web browser</span>
          <span className="desktop-bar-dot" aria-hidden="true" />
        </Button>
        {tooltip}
      </div>
    </div>
  );
}
