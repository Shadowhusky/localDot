import { useLayoutEffect } from "react";
import { keyboardUp, onViewport, pageHeight, pinched, typing } from "./layout.ts";

// Keeps the stack fitted to the visible viewport, including Home Screen launches and keyboard
// dismissal: the keyboard shrinks the app, so the composer rides on it and the thread keeps its end.
// Pinch zoom is a viewing operation and must not reflow the app.
export function useChatFit(page: { current: HTMLElement | null }, on: boolean): void {
  useLayoutEffect(() => {
    const element = page.current;
    const view = window.visualViewport;
    if (!element || !view || !on) return;
    let frame = 0;
    const fit = () => {
      frame = 0;
      // Background tabs and keyboard transitions can briefly report an empty viewport.
      // Never save that transient geometry as the next resting layout.
      if (document.hidden || pinched(view) || !Number.isFinite(view.height) || view.height <= 0)
        return;
      const covered = keyboardUp();
      const up = covered && typing();
      // With no field in focus the keyboard is going, or has gone with WebKit leaving the visual
      // viewport as short as it was: Safari has already put the page back, so the app takes its full
      // height at once and pans back as one piece, rather than shifting by the pan just ended.
      const visible = covered && !up ? pageHeight() : view.height;
      // A fixed shell follows the visual viewport's origin: merely shrinking the app lets Safari pan
      // it away. WebKit can leave offsetTop at the previous keyboard pan after restoring height, so
      // it is clamped to real occluded space, and a resting shell takes no pan at all.
      const offset = Math.min(
        Math.max(0, view.offsetTop || 0),
        Math.max(0, pageHeight() - visible),
      );
      element.toggleAttribute("data-keyboard-up", up);
      const height = `${visible}px`;
      const top = `${up ? offset : 0}px`;
      if (element.style.getPropertyValue("--_visible-h") !== height)
        element.style.setProperty("--_visible-h", height);
      if (element.style.getPropertyValue("--_visible-top") !== top)
        element.style.setProperty("--_visible-top", top);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(fit);
    };
    fit();
    const stop = onViewport(schedule);
    const focus = () => {
      // Safari may begin caret reveal before the next animation frame.
      if (frame) cancelAnimationFrame(frame);
      fit();
    };
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      stop();
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", schedule);
      document.removeEventListener("visibilitychange", schedule);
      element.removeAttribute("data-keyboard-up");
      cancelAnimationFrame(frame);
      element.style.removeProperty("--_visible-h");
      element.style.removeProperty("--_visible-top");
    };
  }, [page, on]);
}
