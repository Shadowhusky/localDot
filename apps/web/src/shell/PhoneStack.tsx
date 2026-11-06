import type { Wearable } from "@localdot/protocol";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { matches, REDUCED_MOTION } from "../ui/media.ts";
import { project } from "../ui/sheet-drag.ts";
import { boxIn, type Flyer, type FlyerBox } from "./phone-flyer.ts";
import { browserTab, type PhoneNav } from "./phone-route.ts";
import { clamp, lerp, onSpringFrame, Spring, Velocity } from "./phone-spring.ts";
import "../ui/phone-layout.css";

const NAV = { response: 0.42, damping: 1 };
// The list drifts this share of the screen as a conversation slides over it.
const DRIFT = 0.28;
const DIM = 0.32;
// A finger starts deciding once it has come this far.
const SLOP = 10;
const SIDEWAYS = 1.3;
// In a browser tab the first of the screen's width belongs to Safari's own back swipe.
const SAFARI_EDGE = 20;
const AT_REST = 0.0008;
const SIDEWAYS_CONTENT = ".md-table, .thread-message pre, .thread-bubble-files";
const TAPS_LIST_FROM = 0.04;

// Scrolls sideways under the finger: a table or a block of code that doesn't fit, which leaves the
// swipe to the content.
function scrollsSideways(from: Element, root: Element): boolean {
  for (let at: Element | null = from; at && at !== root; at = at.parentElement) {
    if (at.scrollWidth <= at.clientWidth + 1) continue;
    const { overflowX } = getComputedStyle(at);
    if (overflowX === "auto" || overflowX === "scroll") return true;
  }
  return false;
}

export interface PhoneStackProps {
  nav: PhoneNav;
  // A tablet: the list beside the conversation.
  split: boolean;
  // The list is out of the way beside the conversation.
  listHidden?: boolean;
  list: ReactNode;
  // The conversation's top bar, and the thread under it.
  bar: ReactNode;
  thread: ReactNode;
  // The computer laid over the conversation, its picture zooming out of the thumbnail.
  computer: ReactNode;
  // Over everything in the stack: banners and toasts.
  over: ReactNode;
  flyer: Flyer;
  // A row's avatar an opening conversation's dot takes off from.
  flightFrom: RefObject<HTMLElement | null>;
  lookOf(id: string): readonly Wearable[] | undefined;
  showDot: boolean;
}

// The phone's stack: the list, the conversation over it and the computer over that. Springs draw it
// and a finger drives the springs, so a change of mind takes over from wherever it has got to; the
// address says which level is on show, so browser Back and links go the same way.
export function PhoneStack({
  nav,
  split,
  listHidden = false,
  list,
  bar,
  thread,
  computer,
  over,
  flyer,
  flightFrom,
  lookOf,
  showDot,
}: PhoneStackProps) {
  const root = useRef<HTMLDivElement>(null);
  const listScreen = useRef<HTMLDivElement>(null);
  const chatScreen = useRef<HTMLDivElement>(null);
  const dim = useRef<HTMLDivElement>(null);
  const edge = useRef<HTMLDivElement>(null);
  const flyerHost = useCallback(
    (element: HTMLSpanElement | null) => flyer.attach(element),
    [flyer],
  );
  const spring = useRef(new Spring(split || nav.route.level > 0 ? 1 : 0));
  const release = useRef<number | undefined>(undefined);
  const flight = useRef<{ from: FlyerBox; to: FlyerBox; a?: Element } | null>(null);
  const dragging = useRef(false);
  const latest = useRef({ nav, split, lookOf, showDot });
  latest.current = { nav, split, lookOf, showDot };
  const level = nav.route.level;
  const routeId = nav.route.id;

  const landFlight = useRef(() => {
    const going = flight.current;
    flight.current = null;
    if (!going) return;
    flyer.land();
    going.a?.removeAttribute("data-gone");
  }).current;

  const draw = useRef(() => {
    const element = root.current;
    const chat = chatScreen.current;
    const under = listScreen.current;
    if (!element || !chat || !under) return;
    if (latest.current.split) {
      chat.style.transform = "";
      under.style.transform = "";
      under.style.pointerEvents = "";
      delete chat.dataset.away;
      return;
    }
    const width = element.clientWidth;
    const p = spring.current.x;
    if (p > AT_REST) delete chat.dataset.away;
    else chat.dataset.away = "";
    chat.style.transform = `translate3d(${(1 - p) * width}px,0,0)`;
    under.style.transform = p > AT_REST ? `translate3d(${-DRIFT * width * p}px,0,0)` : "";
    // A second tap on Back must not land on what the list has under it.
    under.style.pointerEvents = p > TAPS_LIST_FROM ? "none" : "";
    if (dim.current) dim.current.style.opacity = String(p * DIM);
    if (edge.current) edge.current.style.opacity = String(clamp((1 - p) * 8) * clamp(p * 8));
    const going = flight.current;
    if (!going) return;
    if (p > 0.002 && p < 0.998) {
      const fx = going.from.x - DRIFT * width * p;
      const tx = going.to.x + (1 - p) * width;
      const e = p * p * (3 - 2 * p);
      flyer.move({
        x: lerp(fx, tx, e),
        y: lerp(going.from.y, going.to.y, e) - Math.sin(Math.PI * p) * 14,
        w: lerp(going.from.w, going.to.w, e),
      });
    } else if (!spring.current.moving && !dragging.current) landFlight();
  }).current;

  // The dot takes off from its row and lands in the thread's foot, or the other way as it closes.
  const takeOff = useRef((id: string, from: HTMLElement | null) => {
    landFlight();
    const element = root.current;
    const chat = chatScreen.current;
    const look = latest.current.lookOf(id);
    if (!element || !chat || latest.current.split || !latest.current.showDot) return;
    if (matches(REDUCED_MOTION) || !from?.isConnected || !look) return;
    const slot = chat.querySelector(".dot-strip .presence-slot");
    if (!slot) return;
    const width = element.clientWidth;
    const p = spring.current.x;
    const source = boxIn(from, element);
    source.x += DRIFT * width * p;
    const target = boxIn(slot, element);
    target.x -= (1 - p) * width;
    if (target.y < 0 || target.y > element.clientHeight) return;
    flight.current = { from: source, to: target, a: from };
    from.setAttribute("data-gone", "");
    flyer.show(source, look);
  }).current;

  useEffect(() => onSpringFrame(draw), [draw]);

  // The address moved: the stack goes where it says, from wherever it has got to.
  const shown = useRef(level > 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: moving the route is the trigger.
  useLayoutEffect(() => {
    const open = split || level > 0;
    const velocity = release.current;
    release.current = undefined;
    const was = shown.current;
    shown.current = level > 0;
    const going = spring.current;
    if (split || nav.drawnByBrowser.current) {
      going.set(open ? 1 : 0);
      landFlight();
      draw();
      nav.drawnByBrowser.current = false;
      return;
    }
    if (open !== was && !flight.current) {
      const id = routeId ?? lastId.current;
      if (id) {
        const source = open
          ? flightFrom.current
          : (listScreen.current?.querySelector<HTMLElement>(
              `[data-conversation="${id}"] .conversation-avatar`,
            ) ?? null);
        takeOff(id, source);
      }
    }
    flightFrom.current = null;
    going.to(open ? 1 : 0, { ...NAV, velocity, done: landFlight });
    draw();
  }, [level > 0, split]);
  const lastId = useRef(routeId);
  if (routeId) lastId.current = routeId;

  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(element);
    return () => observer.disconnect();
  }, [draw]);

  // Swipe back: from anywhere on the conversation, 1:1, projected on release.
  useEffect(() => {
    const chat = chatScreen.current;
    if (!chat) return;
    let finger: {
      id: number;
      x: number;
      y: number;
      on: boolean;
      base: number;
      v: Velocity;
    } | null = null;
    const down = (event: PointerEvent) => {
      const { nav: now, split: beside } = latest.current;
      if (beside || now.route.level !== 1 || !event.isPrimary) return;
      if (event.pointerType === "mouse") return;
      const target = event.target as Element;
      if (target.closest("input, textarea, [contenteditable], .phone-computer")) return;
      if (scrollsSideways(target, chat)) return;
      const left = chat.getBoundingClientRect().left;
      if (browserTab() && event.pointerType === "touch" && event.clientX - left < SAFARI_EDGE)
        return;
      finger = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        on: false,
        base: 0,
        v: new Velocity(),
      };
    };
    const move = (event: PointerEvent) => {
      if (!finger || event.pointerId !== finger.id) return;
      const dx = event.clientX - finger.x;
      const dy = event.clientY - finger.y;
      if (!finger.on) {
        if (Math.hypot(dx, dy) < SLOP) return;
        if (dx < 0 || Math.abs(dx) < Math.abs(dy) * SIDEWAYS) {
          finger = null;
          return;
        }
        finger.on = true;
        finger.base = dx;
        dragging.current = true;
        spring.current.set(spring.current.x);
        const id = latest.current.nav.route.id;
        if (id && !flight.current)
          takeOff(
            id,
            listScreen.current?.querySelector<HTMLElement>(
              `[data-conversation="${id}"] .conversation-avatar`,
            ) ?? null,
          );
        if (chat.hasPointerCapture?.(event.pointerId) === false)
          chat.setPointerCapture?.(event.pointerId);
      }
      const moved = dx - finger.base;
      const width = root.current?.clientWidth ?? 1;
      spring.current.set(clamp(1 - moved / width));
      finger.v.add(moved);
      draw();
    };
    const up = (event: PointerEvent) => {
      if (!finger || event.pointerId !== finger.id) return;
      const was = finger;
      finger = null;
      dragging.current = false;
      if (!was.on) return;
      const width = root.current?.clientWidth ?? 1;
      const v = was.v.get();
      const moved = (1 - spring.current.x) * width;
      const leaves =
        event.type !== "pointercancel" &&
        (v > 80 ? moved + project(v) > width * 0.35 : moved > width * 0.5);
      if (leaves) {
        release.current = -v / width;
        latest.current.nav.back();
      } else {
        spring.current.to(1, { ...NAV, velocity: -v / width, done: landFlight });
      }
    };
    chat.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      chat.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [landFlight, takeOff, draw]);

  // The bar's glass, while the thread runs under it, and a tap on the thread drops the keyboard, as
  // Messages does.
  useEffect(() => {
    const chat = chatScreen.current;
    if (!chat) return;
    const scrolled = (event: Event) => {
      const target = event.target as HTMLElement;
      if (!target.matches?.(".thread-scroll")) return;
      chat
        .querySelector(".phone-chat-bar")
        ?.toggleAttribute(
          "data-under",
          target.scrollTop > 2 && target.scrollHeight > target.clientHeight + 4,
        );
    };
    let press: { x: number; y: number } | null = null;
    const pressed = (event: PointerEvent) => {
      press = { x: event.clientX, y: event.clientY };
    };
    const lifted = (event: PointerEvent) => {
      const target = event.target as Element;
      const was = press;
      press = null;
      if (!was || Math.hypot(event.clientX - was.x, event.clientY - was.y) > SLOP) return;
      if (!target.closest(".thread-scroll") || target.closest("button, a, input, textarea")) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches("textarea, input")) active.blur();
    };
    chat.addEventListener("scroll", scrolled, { capture: true, passive: true });
    chat.addEventListener("pointerdown", pressed, true);
    chat.addEventListener("pointerup", lifted, true);
    return () => {
      chat.removeEventListener("scroll", scrolled, { capture: true });
      chat.removeEventListener("pointerdown", pressed, true);
      chat.removeEventListener("pointerup", lifted, true);
    };
  }, []);

  // A table or block of code that doesn't fit takes a sideways finger; one that fits leaves it to
  // the swipe back. The browser reads this as the finger lands, so it is written ahead.
  useEffect(() => {
    const chat = chatScreen.current;
    if (!chat || typeof MutationObserver === "undefined") return;
    let frame = 0;
    const mark = () => {
      frame = 0;
      for (const element of chat.querySelectorAll<HTMLElement>(SIDEWAYS_CONTENT))
        element.style.touchAction =
          element.scrollWidth > element.clientWidth + 1 ? "pan-x pan-y" : "pan-y";
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(mark);
    };
    soon();
    const changes = new MutationObserver(soon);
    changes.observe(chat, { childList: true, subtree: true });
    window.addEventListener("resize", soon);
    return () => {
      cancelAnimationFrame(frame);
      changes.disconnect();
      window.removeEventListener("resize", soon);
    };
  }, []);

  return (
    <div
      ref={root}
      className="phone-stack"
      data-split={split || undefined}
      data-list-hidden={(split && listHidden) || undefined}
      data-level={level}
    >
      <div ref={listScreen} className="phone-screen phone-list" inert={!split && level > 0}>
        {list}
        <div ref={dim} className="phone-dim" />
      </div>
      <div
        ref={chatScreen}
        className="phone-screen phone-chat"
        inert={!split && level === 0}
        data-away={level === 0 && !split ? "" : undefined}
      >
        <div ref={edge} className="phone-edge" />
        <div className="phone-chat-col" inert={level === 2}>
          {bar}
          {thread}
        </div>
        {computer}
      </div>
      <span ref={flyerHost} className="dot phone-flyer" aria-hidden="true" />
      {over}
    </div>
  );
}
