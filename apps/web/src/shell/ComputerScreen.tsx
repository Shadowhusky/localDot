import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n/index.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu } from "../ui/Menu.tsx";
import { matches } from "../ui/media.ts";
import { triggerProps } from "../ui/Popover.tsx";
import { project } from "../ui/sheet-drag.ts";
import { LANDSCAPE_PHONE } from "./layout.ts";
import { clamp, lerp, onSpringFrame, Spring, Velocity } from "./phone-spring.ts";
import "../ui/phone-layout.css";

const AT_REST = 0.0008;
const OPENING = { response: 0.46, damping: 1 };
const CLOSING = { response: 0.42, damping: 1 };
const SLOP = 10;
const PICTURE_RATIO = 1.6;
// Under the picture on a tall screen: dot's line, a few steps, the controls and the steer box.
const BELOW_PX = 360;
const LEAST_PICTURE = 240;
const THUMB_RADIUS = 8;
const BUTTON_RADIUS = 18;
const OPEN_RADIUS = 14;

export interface ComputerScreenProps {
  open: boolean;
  // The browser drew the way here itself.
  drawnByBrowser: { current: boolean };
  // In the thread's foot, where the picture rests while this task holds the computer.
  thumb: HTMLElement | null;
  // Where the picture grows from when there is no thumbnail.
  monitor: RefObject<HTMLElement | null>;
  // The stage, one live picture wherever it rests.
  picture: ReactNode;
  // In the picture's place, while there is no picture to show.
  curtain?: ReactNode;
  // The user has the computer: a finger on the picture is theirs, not a way back.
  yours: boolean;
  title: string;
  status: ReactNode;
  // dot and its line, under the picture.
  band?: ReactNode;
  steps: ReactNode;
  controls: ReactNode;
  // The composer moves here as the steer box.
  dockRef(element: HTMLDivElement | null): void;
  menu: ReactNode;
  onBack(): void;
}

// The computer: the one picture zooms out of the thumbnail into its place here and back, and a drag
// down or to the right puts it back.
export function ComputerScreen({
  open,
  drawnByBrowser,
  thumb,
  monitor,
  picture,
  curtain,
  yours,
  title,
  status,
  band,
  steps,
  controls,
  dockRef,
  menu,
  onBack,
}: ComputerScreenProps) {
  const screen = useRef<HTMLElement>(null);
  const room = useRef<HTMLDivElement>(null);
  const ui = useRef<HTMLDivElement>(null);
  const bg = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "phone-picture";
    return element;
  });
  const zoom = useRef(new Spring(open ? 1 : 0));
  const release = useRef<number | undefined>(undefined);
  const from = useRef<{ x: number; y: number; w: number; h: number; button: boolean } | null>(null);
  const drag = useRef(false);
  const latest = useRef({ thumb, curtain: !!curtain, yours, onBack });
  latest.current = { thumb, curtain: !!curtain, yours, onBack };

  const target = useRef(() => {
    const layer = screen.current;
    const place = room.current;
    if (!layer || !place) return null;
    const base = layer.getBoundingClientRect();
    if (matches(LANDSCAPE_PHONE)) {
      const box = ui.current ? getComputedStyle(ui.current) : null;
      const length = (value?: string) => Number.parseFloat(value ?? "0") || 0;
      const top = length(box?.paddingTop);
      const left = length(box?.paddingLeft);
      const right = base.width - length(box?.paddingRight);
      const width = Math.min((base.height - top - 8) * PICTURE_RATIO, right - left);
      return {
        x: Math.max(left, Math.min((base.width - width) / 2, right - width)),
        y: top + 4,
        w: width,
        h: width / PICTURE_RATIO,
      };
    }
    const width = Math.min(
      base.width - 16,
      Math.max(LEAST_PICTURE, (base.height - BELOW_PX) * PICTURE_RATIO),
    );
    place.style.height = `${Math.round(width / PICTURE_RATIO)}px`;
    layer.style.setProperty("--_picture-w", `${Math.round(width)}px`);
    const at = place.getBoundingClientRect();
    return {
      x: at.left - base.left + (at.width - width) / 2,
      y: at.top - base.top,
      w: width,
      h: width / PICTURE_RATIO,
    };
  }).current;

  const measureFrom = useRef(() => {
    const layer = screen.current;
    const { thumb: slot } = latest.current;
    const source = slot?.isConnected ? slot : monitor.current;
    if (!layer || !source) {
      from.current = null;
      return;
    }
    const base = layer.getBoundingClientRect();
    const at = source.getBoundingClientRect();
    from.current = {
      x: at.left - base.left,
      y: at.top - base.top,
      w: at.width,
      h: at.height,
      button: source !== slot,
    };
  }).current;

  const draw = useRef(() => {
    const layer = screen.current;
    const to = target();
    if (!layer || !to) return;
    const z = zoom.current.x;
    host.style.width = `${to.w}px`;
    host.style.height = `${to.h}px`;
    const { thumb: slot, curtain: covered } = latest.current;
    if (z <= AT_REST) {
      layer.dataset.closed = "";
      layer.parentElement?.removeAttribute("data-covered");
      from.current = null;
      if (slot) {
        if (host.parentElement !== slot) slot.append(host);
        host.dataset.place = "thumb";
        host.style.opacity = "";
        host.style.borderRadius = "";
        host.style.overflow = "";
        host.style.transform = `scale(${slot.clientWidth / to.w}, ${slot.clientHeight / to.h})`;
        slot.closest(".phone-thumb")?.removeAttribute("data-gone");
      } else {
        if (host.parentElement !== layer) layer.append(host);
        host.dataset.place = "away";
      }
      return;
    }
    delete layer.dataset.closed;
    layer.parentElement?.toggleAttribute("data-covered", z >= 1);
    if (!from.current) measureFrom();
    if (host.parentElement !== layer) layer.append(host);
    host.dataset.place = covered ? "away" : "open";
    slot?.closest(".phone-thumb")?.setAttribute("data-gone", "");
    if (bg.current) bg.current.style.opacity = String(clamp(z * 1.6));
    const shown = clamp((z - 0.3) / 0.7);
    if (ui.current) {
      ui.current.style.opacity = String(shown);
      ui.current.style.transform = z < 1 ? `translate3d(0,${(1 - z) * 16}px,0)` : "";
    }
    if (bar.current) bar.current.style.opacity = String(shown);
    const start = from.current ?? { x: to.x, y: to.y, w: to.w, h: to.h, button: false };
    const w = lerp(start.w, to.w, z);
    const h = lerp(start.h, to.h, z);
    const sx = w / to.w;
    const sy = h / to.h;
    host.style.transform = `translate3d(${lerp(start.x, to.x, z)}px,${lerp(start.y, to.y, z)}px,0) scale(${sx},${sy})`;
    const radius = lerp(start.button ? BUTTON_RADIUS : THUMB_RADIUS, OPEN_RADIUS, z);
    host.style.borderRadius = `${radius / sx}px / ${radius / sy}px`;
    // On its way it has the corners it arrives with; at rest the stage's own edge is all it needs.
    host.style.overflow = z < 1 ? "hidden" : "";
    host.style.opacity = start.button ? String(clamp(z * 3)) : "1";
  }).current;

  useEffect(() => onSpringFrame(draw), [draw]);
  // A thumbnail that comes or goes, a curtain, a phone turned or a keyboard up moves the picture.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each is a trigger, read through its ref.
  useLayoutEffect(() => {
    from.current = null;
    draw();
  }, [thumb, !!curtain, draw]);
  useEffect(() => {
    const layer = screen.current;
    if (!layer || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      from.current = null;
      draw();
    });
    observer.observe(layer);
    if (thumb) observer.observe(thumb);
    return () => observer.disconnect();
  }, [draw, thumb]);

  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      draw();
      return;
    }
    const velocity = release.current;
    release.current = undefined;
    if (open) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches("textarea, input")) active.blur();
    }
    if (drawnByBrowser.current) {
      drawnByBrowser.current = false;
      zoom.current.set(open ? 1 : 0);
      draw();
      return;
    }
    from.current = null;
    if (zoom.current.x <= AT_REST) measureFrom();
    zoom.current.to(open ? 1 : 0, {
      ...(open ? OPENING : CLOSING),
      velocity,
      done: () => draw(),
    });
    draw();
  }, [open, draw, measureFrom, drawnByBrowser]);

  useEffect(() => {
    const layer = screen.current;
    if (!layer) return;
    let finger: {
      id: number;
      x: number;
      y: number;
      way: "down" | "right" | null;
      span: number;
      base: number;
      v: Velocity;
    } | null = null;
    const down = (event: PointerEvent) => {
      if (zoom.current.target !== 1 || !event.isPrimary) return;
      if (event.pointerType === "mouse") return;
      const at = event.target as Element;
      if (latest.current.yours && at.closest(".phone-picture")) return;
      if (at.closest("button, a, input, textarea, .phone-steps, .thread-dock")) return;
      finger = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        way: null,
        span: 1,
        base: 0,
        v: new Velocity(),
      };
    };
    const move = (event: PointerEvent) => {
      if (!finger || event.pointerId !== finger.id) return;
      const dx = event.clientX - finger.x;
      const dy = event.clientY - finger.y;
      if (!finger.way) {
        if (Math.hypot(dx, dy) < SLOP) return;
        if (dy > 0 && dy > Math.abs(dx)) finger.way = "down";
        else if (dx > 0 && dx > Math.abs(dy) * 1.2) finger.way = "right";
        else {
          finger = null;
          return;
        }
        drag.current = true;
        zoom.current.set(zoom.current.x);
        const box = layer.getBoundingClientRect();
        finger.span = finger.way === "down" ? box.height * 0.6 : box.width;
        finger.base = finger.way === "down" ? dy : dx;
        if (!from.current) measureFrom();
      }
      const moved = (finger.way === "down" ? dy : dx) - finger.base;
      zoom.current.set(clamp(1 - moved / finger.span));
      finger.v.add(moved);
      draw();
    };
    const up = (event: PointerEvent) => {
      if (!finger || event.pointerId !== finger.id) return;
      const was = finger;
      finger = null;
      drag.current = false;
      if (!was.way) return;
      const v = was.v.get();
      const moved = (1 - zoom.current.x) * was.span;
      if (event.type !== "pointercancel" && moved + project(v) > was.span * 0.35) {
        release.current = -v / was.span;
        latest.current.onBack();
      } else {
        zoom.current.to(1, { ...CLOSING, velocity: -v / was.span });
      }
    };
    layer.addEventListener("pointerdown", down);
    host.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      layer.removeEventListener("pointerdown", down);
      host.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [draw, host, measureFrom]);

  const [menuOpen, setMenuOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  return (
    <section
      ref={screen}
      className="phone-computer"
      aria-label={t`Computer`}
      inert={!open}
      data-curtain={curtain ? "" : undefined}
    >
      <div ref={bg} className="phone-computer-bg" />
      <div ref={ui} className="phone-computer-ui">
        {curtain ? (
          <div className="phone-computer-curtain">{curtain}</div>
        ) : (
          <>
            <div ref={room} className="phone-picture-room" />
            {band && <div className="phone-computer-line">{band}</div>}
          </>
        )}
        {curtain && <div ref={room} className="phone-picture-room" data-empty="" />}
        {!curtain && <div className="phone-steps">{steps}</div>}
        {!curtain && (
          <div className="phone-computer-bottom">
            <div className="phone-computer-controls">{controls}</div>
            <div ref={dockRef} className="phone-computer-dock" />
          </div>
        )}
      </div>
      <div ref={bar} className="phone-bar phone-computer-bar" data-sub="">
        <div className="phone-bar-row">
          <IconButton
            size={36}
            round
            variant="filled"
            icon="chevron-left"
            label={t`Back to the conversation`}
            onClick={onBack}
          />
          <div className="phone-title">
            <span className="phone-title-text">{title}</span>
            <span className="phone-title-sub">
              <span className="phone-title-sub-in num">{status}</span>
            </span>
          </div>
          <IconButton
            ref={more}
            size={36}
            round
            variant="filled"
            icon="more-horizontal"
            label={t`More`}
            {...triggerProps("menu", menuOpen)}
            onClick={() => setMenuOpen(true)}
          />
          <Menu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchor={more}
            side="bottom"
            align="end"
            label={t`More`}
          >
            {menu}
          </Menu>
        </div>
      </div>
      {createPortal(picture, host)}
    </section>
  );
}
