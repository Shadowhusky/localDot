import type { ScreenName } from "@localdot/protocol";
import {
  type CSSProperties,
  type PointerEvent,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  BrowserEngineName,
  BrowserEngineStatus,
} from "../../../../packages/protocol/src/browser-engine.ts";
import { Button } from "../ui/Button.tsx";
import { showToast } from "../ui/Toast.tsx";
import { useTooltip } from "../ui/Tooltip.tsx";
import "../ui/browser-window.css";
import { BrowserIcon } from "./BrowserIcon.tsx";
import { browserWindow } from "./composite.ts";
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

// What the running web browser is: until it restarts, a change waits.
export function runningEngine(status: BrowserEngineStatus | null): BrowserEngineName | undefined {
  if (!status) return undefined;
  if (!status.restartNeeded) return status.engine;
  return status.engine === "chrome" ? "chromium" : "chrome";
}

export function browserName(engine: BrowserEngineName | undefined): string {
  if (engine === "chrome") return "Google Chrome";
  if (engine === "chromium") return "Chromium";
  return "Web browser";
}

export function dockItemLabel(front: StageFront): string {
  if (front.screen === "browser") return "Minimise the web browser";
  return front.dot === "browser"
    ? "Show the web browser, where dot is working"
    : "Show the web browser";
}

// How long the dock stays up once the pointer has left it, as the desktop's own does, and after a
// tap on the bottom edge, which no pointer leaves.
const DOCK_HIDE_MS = 300;
const DOCK_TAP_MS = 4000;
// The window in the desktop's own 1280 × 800 measure, which the stylesheet draws it in.
const FRAME = browserWindow({ w: 1280, h: 800 });
const PLACE = { "--_left": FRAME.x, "--_width": FRAME.w } as CSSProperties;

const keepKeys = (event: SyntheticEvent) => event.preventDefault();
const stay = (event: SyntheticEvent) => event.stopPropagation();

// The web browser as one of the desktop's own apps: a window with the desktop's title bar while it
// is in front, and an item in the dock's glass at the bottom, which shows the window or minimises it
// as a dock does. With nothing over the dock it is the dock's last item, on the shelf the desktop
// draws. Like that dock (Plank's window-dodge), it gets out of the way of any window over the dock,
// its own included, and comes back on a shelf of its own while the pointer is at the bottom edge or
// for a moment after a tap there.
export function BrowserWindow({
  screen,
  drawn,
  front,
  holding,
  engine,
  covered,
}: {
  // What is in front.
  screen: ScreenName;
  // The stage shows that screen's own picture: the window's frame comes with the page in it.
  drawn: boolean;
  // Who picks what is in front; without it the stage only shows the window.
  front?: StageFront;
  holding: boolean;
  engine?: BrowserEngineName;
  // A desktop window lies over the dock; null while the computer hasn't said.
  covered: boolean | null;
}) {
  const open = screen === "browser";
  const name = browserName(engine);
  const crossed = useRef(screen);
  useEffect(() => {
    if (crossed.current === screen) return;
    crossed.current = screen;
    if (holding) sayApart();
  }, [screen, holding]);
  const problem = front?.problem;
  useEffect(() => {
    if (problem) showToast({ id: "screen", title: problem, tone: "danger" });
  }, [problem]);
  const dodging = open || covered !== false;
  const [raised, setRaised] = useState(false);
  if (raised && !dodging) setRaised(false);
  const lowering = useRef<ReturnType<typeof setTimeout>>(undefined);
  const touched = useRef(false);
  useEffect(() => () => clearTimeout(lowering.current), []);
  const lower = (ms = DOCK_HIDE_MS) => {
    clearTimeout(lowering.current);
    lowering.current = setTimeout(() => setRaised(false), ms);
  };
  const hover = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    clearTimeout(lowering.current);
    setRaised(true);
  };
  const leave = (event: PointerEvent) => {
    if (event.pointerType === "mouse") lower();
  };
  const tap = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    setRaised(true);
    lower(DOCK_TAP_MS);
  };
  const { triggerProps, tooltip } = useTooltip({ content: name });
  return (
    <div className="browser-chrome">
      <div className="browser-chrome-screen" style={PLACE}>
        {open && drawn && (
          // biome-ignore lint/a11y/useSemanticElements: a window's title bar is no form's fieldset.
          <div
            className="browser-titlebar"
            role="group"
            aria-label={`${name} window`}
            onMouseDown={keepKeys}
            onDoubleClick={stay}
          >
            {front && (
              <Button
                className="browser-minimise"
                variant="quiet"
                size="sm"
                aria-label="Minimise the web browser"
                onMouseDown={keepKeys}
                onClick={() => front.pick("desktop")}
              >
                <span className="browser-minimise-glyph" aria-hidden="true" />
              </Button>
            )}
            <span className="browser-title">{name}</span>
          </div>
        )}
        {front && (
          <div
            className="browser-dock"
            data-shown={!dodging || raised ? "" : undefined}
            data-joined={dodging ? undefined : ""}
            onPointerEnter={dodging ? hover : undefined}
            onPointerLeave={dodging ? leave : undefined}
          >
            <Button
              {...triggerProps.handlers}
              className="browser-dock-item"
              variant="quiet"
              size="sm"
              aria-label={dockItemLabel(front)}
              aria-description={APART_NOTE}
              data-open={open || undefined}
              data-dot={front.dot === "browser" ? "" : undefined}
              onMouseDown={keepKeys}
              onDoubleClick={stay}
              onPointerDown={(event) => {
                touched.current = event.pointerType !== "mouse";
              }}
              onClick={() => {
                front.pick(open ? "desktop" : "browser");
                // A finger leaves no pointer over the dock to keep it up.
                if (touched.current) lower();
              }}
            >
              <BrowserIcon engine={engine} />
              <span className="browser-dock-dot" aria-hidden="true" />
            </Button>
            {tooltip}
          </div>
        )}
        {front && dodging && (
          <div
            className="browser-dock-edge"
            aria-hidden="true"
            onPointerEnter={hover}
            onPointerLeave={leave}
            onPointerDown={tap}
          />
        )}
      </div>
    </div>
  );
}
