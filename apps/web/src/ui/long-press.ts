// How long a still finger holds before a row lifts into its preview, about as long as iOS waits
// before its own context menu.
export const HOLD_MS = 450;
// A finger that moves further than this is scrolling or swiping, not holding.
const SLOP = 8;
// A right click or the browser's own long press soon after a hold is that same hold.
const SAME_HOLD_MS = 1000;
// How long after the held finger lifts its click can still come.
const LIFT_CLICK_MS = 600;

export interface LongPressHost {
  // A finger came down and may be holding, or is no longer: what it presses can sink a little while
  // it waits, as on iOS.
  pressing?(on: boolean): void;
  // Held still long enough, or asked for by a right click (Android reports its long press as one).
  hold(): void;
}

// Touch and hold on `element`, or a right click on it. What a hold opens appears under the finger,
// so the click its lifting sends is spent, wherever it lands: a menu item that came up under the
// finger is never chosen by letting go.
export function attachLongPress(element: HTMLElement, host: LongPressHost): () => void {
  let press: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined;
  let heldAt = Number.NEGATIVE_INFINITY;
  let spending: (() => void) | undefined;
  // A name being typed keeps the browser's own hold, which selects and pastes.
  const typing = (event: Event) =>
    event.target instanceof Element && !!event.target.closest("input, textarea");

  const stop = () => {
    if (!press) return;
    clearTimeout(press.timer);
    press = undefined;
    host.pressing?.(false);
  };

  const spendLift = (id: number) => {
    spending?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const spend = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      done();
    };
    const lifted = (event: PointerEvent) => {
      if (event.pointerId === id) timer = setTimeout(done, LIFT_CLICK_MS);
    };
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("click", spend, true);
      window.removeEventListener("pointerup", lifted, true);
      window.removeEventListener("pointercancel", lifted, true);
      window.removeEventListener("pointerdown", done, true);
      spending = undefined;
    };
    window.addEventListener("click", spend, true);
    window.addEventListener("pointerup", lifted, true);
    window.addEventListener("pointercancel", lifted, true);
    window.addEventListener("pointerdown", done, true);
    spending = done;
  };

  const fire = () => {
    const finger = press?.id;
    stop();
    heldAt = performance.now();
    if (finger !== undefined) spendLift(finger);
    host.hold();
  };

  const onPointerDown = (event: PointerEvent) => {
    stop();
    heldAt = Number.NEGATIVE_INFINITY;
    if (event.pointerType === "mouse" || event.button !== 0 || !event.isPrimary || typing(event))
      return;
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(fire, HOLD_MS),
    };
    host.pressing?.(true);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > SLOP) stop();
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (press && event.pointerId === press.id) stop();
  };

  const onContextMenu = (event: MouseEvent) => {
    if (typing(event)) return;
    event.preventDefault();
    if (performance.now() - heldAt > SAME_HOLD_MS) fire();
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerEnd);
  window.addEventListener("pointercancel", onPointerEnd);
  window.addEventListener("scroll", stop, { capture: true, passive: true });
  // A lift still to come is spent even if the element goes meanwhile.
  return () => {
    stop();
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerEnd);
    window.removeEventListener("pointercancel", onPointerEnd);
    window.removeEventListener("scroll", stop, { capture: true });
  };
}
