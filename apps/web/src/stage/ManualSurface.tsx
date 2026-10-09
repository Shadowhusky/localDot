import type { ManualStreamInput, Point } from "@localdot/protocol";
import {
  forwardRef,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isApple, modsOf, routeKey, textEdit, textInputs } from "./manual-keys.ts";

export type PointerMode = "click" | "double" | "right";
export interface ManualSurfaceHandle {
  keyboard(on: boolean): void;
}
export interface ManualSurfaceProps {
  // Input reaches the computer now.
  live: boolean;
  mode: PointerMode;
  // Where a page point falls on the computer's screen, or null off it. A pointer already pressed
  // on the screen (`follow`) stays on its edge instead.
  locate(point: Point, follow: boolean): Point | null;
  send(input: ManualStreamInput): void;
  onTyping?(typing: boolean): void;
  // Why a paste was not typed, or null once one is.
  onRefused?(message: string | null): void;
}
interface Press {
  id: number;
  button: "left" | "middle" | "right";
  // In Double-click and Right-click modes the main button clicks once it lifts.
  tap: boolean;
  touch: boolean;
  at: Point;
  last: Point;
  client: { x: number; y: number };
  moved: boolean;
  mods: ReturnType<typeof modsOf>;
}

// A touch, or a press that clicks once it lifts, moves this far before it drags or is dropped.
const SLOP = 6;
// All the keyboard field holds between keys: a phone keyboard reports its Backspace only by deleting
// something, and nothing typed stays in the page.
const PAD = "\u200b".repeat(4);
// Wheel travel per notch, by deltaMode: pixels, lines, pages.
const NOTCH = [50, 3, 0.1];
const PASTE_LIMIT = 4000;
const ESCAPE_TWICE_MS = 500;
const notches = (n: number) => Math.max(-32, Math.min(32, n));
// Whole notches of travel, forgiving the float error of fractions that add up to one.
const whole = (n: number) => Math.trunc(n + Math.sign(n) * 1e-9);

// The computer itself while the user holds control: the pointer goes to it as it moves, and
// every key typed into the hidden keyboard field goes to it in order.
export const ManualSurface = forwardRef<ManualSurfaceHandle, ManualSurfaceProps>(
  function ManualSurface({ live, mode, locate, send, onTyping, onRefused }, ref) {
    const surface = useRef<HTMLDivElement>(null);
    const field = useRef<HTMLTextAreaElement>(null);
    const [typing, setTyping] = useState(false);
    const apple = useMemo(isApple, []);
    const props = useRef({ live, mode, locate, send, onTyping, onRefused });
    useLayoutEffect(() => {
      props.current = { live, mode, locate, send, onTyping, onRefused };
    });
    const state = useRef({
      // What the keyboard field holds: the pad, then a composition already typed on the computer.
      mirror: "",
      composing: false,
      // The field's text when a composition began, which its result follows.
      base: "",
      escape: 0,
      press: null as Press | null,
      hover: null as Point | null,
      sent: null as Point | null,
      frame: 0,
      wheel: { dx: 0, dy: 0 },
    });

    // Built once: they read the latest props and state through refs.
    const { move, flushHover, emit, reset, sync } = useMemo(() => {
      const move = (at: Point) => {
        const s = state.current;
        if (!props.current.live || (s.sent?.x === at.x && s.sent?.y === at.y)) return;
        s.sent = at;
        props.current.send({ kind: "move", at });
      };
      const flushHover = () => {
        const s = state.current;
        cancelAnimationFrame(s.frame);
        s.frame = 0;
        if (s.hover) move(s.hover);
        s.hover = null;
      };
      const emit = (input: ManualStreamInput) => {
        flushHover();
        if ("at" in input) state.current.sent = input.at;
        props.current.send(input);
      };
      // Back to the pad alone. A composition keeps its text until it is committed.
      const reset = () => {
        const s = state.current;
        if (s.composing) return;
        s.mirror = props.current.live ? PAD : "";
        if (field.current && field.current.value !== s.mirror) field.current.value = s.mirror;
      };
      const sync = () => {
        const s = state.current,
          el = field.current;
        if (!el || s.composing) return;
        if (props.current.live) {
          const edit = textEdit(s.mirror, el.value);
          for (let i = 0; i < edit.erase; i++) emit({ kind: "key", combo: ["backspace"] });
          for (const input of textInputs(edit.text)) emit(input);
        }
        reset();
      };
      return { move, flushHover, emit, reset, sync };
    }, []);

    useImperativeHandle(ref, () => ({
      keyboard(on) {
        if (on && props.current.live) field.current?.focus();
        else field.current?.blur();
      },
    }));
    useEffect(() => {
      if (live) return;
      const s = state.current;
      cancelAnimationFrame(s.frame);
      s.frame = 0;
      s.hover = null;
      field.current?.blur();
    }, [live]);
    useEffect(() => {
      const el = surface.current;
      if (!el) return;
      const wheel = (event: WheelEvent) => {
        if (!props.current.live) return;
        event.preventDefault();
        const at = props.current.locate({ x: event.clientX, y: event.clientY }, false);
        if (!at) return;
        const travel = state.current.wheel,
          per = NOTCH[event.deltaMode] ?? 50;
        travel.dx += event.deltaX / per;
        travel.dy += event.deltaY / per;
        const dx = whole(travel.dx),
          dy = whole(travel.dy);
        if (!dx && !dy) return;
        travel.dx -= dx;
        travel.dy -= dy;
        const mods = modsOf(event, apple);
        emit({
          kind: "scroll",
          at,
          dx: notches(dx),
          dy: notches(dy),
          ...(mods.length ? { mods } : {}),
        });
      };
      // A tap keeps the phone keyboard up and makes no page selection or callout.
      const touch = (event: TouchEvent) => {
        if (props.current.live) event.preventDefault();
      };
      const hide = () => reset();
      el.addEventListener("wheel", wheel, { passive: false });
      el.addEventListener("touchstart", touch, { passive: false });
      window.addEventListener("pagehide", hide);
      return () => {
        el.removeEventListener("wheel", wheel);
        el.removeEventListener("touchstart", touch);
        window.removeEventListener("pagehide", hide);
        cancelAnimationFrame(state.current.frame);
      };
    }, [apple, emit, reset]);

    const down = (event: PointerEvent<HTMLDivElement>) => {
      const now = props.current,
        s = state.current;
      if (!now.live || s.press) return;
      event.preventDefault();
      const at = now.locate({ x: event.clientX, y: event.clientY }, false);
      if (!at) return;
      if (event.pointerType !== "touch") field.current?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture?.(event.pointerId);
      reset();
      const button = event.button === 1 ? "middle" : event.button === 2 ? "right" : "left";
      const mods = modsOf(event, apple);
      s.press = {
        id: event.pointerId,
        button,
        tap: event.button === 0 && now.mode !== "click",
        touch: event.pointerType === "touch",
        at,
        last: at,
        client: { x: event.clientX, y: event.clientY },
        moved: false,
        mods,
      };
      if (!s.press.tap) emit({ kind: "down", at, button, ...(mods.length ? { mods } : {}) });
    };
    const moved = (event: PointerEvent<HTMLDivElement>) => {
      const now = props.current,
        s = state.current,
        press = s.press;
      if (!now.live || (press && press.id !== event.pointerId)) return;
      if (!press && event.pointerType !== "mouse") return;
      if (press && !press.moved) {
        const far = Math.hypot(event.clientX - press.client.x, event.clientY - press.client.y);
        if ((press.touch || press.tap) && far < SLOP) return;
        press.moved = true;
      }
      if (press?.tap) return;
      const at = now.locate({ x: event.clientX, y: event.clientY }, !!press);
      if (!at) return;
      if (press) {
        press.last = at;
        flushHover();
        move(at);
        return;
      }
      s.hover = at;
      s.frame ||= requestAnimationFrame(flushHover);
    };
    const up = (event: PointerEvent<HTMLDivElement>) => {
      const now = props.current,
        press = state.current.press;
      if (!press || press.id !== event.pointerId) return;
      state.current.press = null;
      if (!now.live) return;
      if (press.tap) {
        if (!press.moved)
          emit({
            kind: "click",
            at: press.at,
            button: now.mode === "right" ? "right" : "left",
            count: now.mode === "double" ? 2 : 1,
            ...(press.mods.length ? { mods: press.mods } : {}),
          });
        return;
      }
      // A finger that wobbled less than the slop lets go where it pressed, so the press stays a click.
      const at = press.moved
        ? (now.locate({ x: event.clientX, y: event.clientY }, true) ?? press.last)
        : press.at;
      emit({ kind: "up", at, button: press.button });
    };
    // The browser took the pointer away (a system gesture): let go where it last was.
    const lost = (event: PointerEvent<HTMLDivElement>) => {
      const press = state.current.press;
      if (!press || press.id !== event.pointerId) return;
      state.current.press = null;
      if (!press.tap && props.current.live)
        emit({ kind: "up", at: press.last, button: press.button });
    };

    const key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const s = state.current;
      if (event.defaultPrevented || !props.current.live) return;
      if (
        event.key === "Escape" &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        if (event.timeStamp - s.escape < ESCAPE_TWICE_MS) {
          event.preventDefault();
          s.escape = 0;
          field.current?.blur();
          return;
        }
        s.escape = event.timeStamp;
      }
      const route = routeKey(event.nativeEvent, apple);
      if (route.kind !== "key") return;
      event.preventDefault();
      reset();
      emit({ kind: "key", combo: route.combo });
    };

    return (
      <>
        <div
          ref={surface}
          className="manual-surface"
          data-live={live ? "" : undefined}
          data-typing={typing ? "" : undefined}
          aria-hidden="true"
          onPointerDown={down}
          onPointerMove={moved}
          onPointerUp={up}
          onPointerCancel={lost}
          onLostPointerCapture={lost}
          onContextMenu={(event) => event.preventDefault()}
          onDragStart={(event) => event.preventDefault()}
        />
        <textarea
          ref={field}
          className="manual-keyboard"
          aria-label="Type on the computer"
          rows={1}
          readOnly={!live}
          tabIndex={live ? undefined : -1}
          aria-disabled={live ? undefined : true}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={key}
          onInput={sync}
          onCompositionStart={() => {
            state.current.composing = true;
            state.current.base = state.current.mirror;
          }}
          onCompositionEnd={(event) => {
            // The committed text is the event's: some browsers update the field only after it, so
            // the field returns to the pad once that input has come.
            const s = state.current;
            s.composing = false;
            if (props.current.live) for (const input of textInputs(event.data ?? "")) emit(input);
            s.mirror = s.base + (event.data ?? "");
            setTimeout(sync);
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            if (!props.current.live || !text) return;
            if ([...text].length > PASTE_LIMIT) {
              props.current.onRefused?.("Paste up to 4,000 characters at a time.");
              return;
            }
            reset();
            props.current.onRefused?.(null);
            for (const input of textInputs(text)) emit(input);
          }}
          onFocus={() => {
            reset();
            setTyping(true);
            props.current.onTyping?.(true);
          }}
          onBlur={() => {
            state.current.composing = false;
            reset();
            setTyping(false);
            props.current.onTyping?.(false);
          }}
        />
      </>
    );
  },
);
