import { useLayoutEffect, useRef, useState } from "react";

const KEY = "localdot.mobile-screen-minimized";
// Keep the live screen mounted while it folds; restoring it must not reconnect the computer.
export function useMobileScreen(phone: boolean) {
  const [minimized, setMinimized] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "true";
    } catch {
      return false;
    }
  });
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    const frame = host?.querySelector<HTMLElement>(".stage-frame");
    if (!phone || !host || !frame) return;
    const measure = () => {
      const height = `${frame.offsetHeight}px`;
      if (host.style.getPropertyValue("--mobile-screen-height") !== height)
        host.style.setProperty("--mobile-screen-height", height);
    };
    measure();
    // Changing an ancestor's max-height inside ResizeObserver resizes the sibling conversation
    // in the same delivery cycle. WebKit reports a loop on full-screen exit. Coalesce that write
    // into the next frame; keep the first measurement synchronous for the initial layout.
    let pending: number | undefined;
    const observer = new ResizeObserver(() => {
      if (pending !== undefined) return;
      pending = requestAnimationFrame(() => {
        pending = undefined;
        measure();
      });
    });
    observer.observe(frame);
    return () => {
      observer.disconnect();
      if (pending !== undefined) cancelAnimationFrame(pending);
    };
  }, [phone]);
  return {
    ref,
    minimized: phone && minimized,
    setMinimized(value: boolean) {
      setMinimized(value);
      try {
        localStorage.setItem(KEY, String(value));
      } catch {}
    },
  };
}
