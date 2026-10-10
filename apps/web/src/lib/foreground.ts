// Browsers report an app return differently: tab visibility, window focus, bfcache pageshow,
// or Page Lifecycle resume. Treat a burst as one refresh, but never skip a new hidden/visible trip.
export function onForeground(refresh: (reason: string) => void): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};
  let last = Number.NEGATIVE_INFINITY;
  let reason = "";
  const shown = (event: Event) => {
    if (document.visibilityState === "hidden") {
      last = Number.NEGATIVE_INFINITY;
      return;
    }
    const now = performance.now();
    if (now - last < 500 && !(event.type === "resume" && reason !== "resume")) return;
    last = now;
    reason = event.type;
    refresh(reason);
  };
  document.addEventListener("visibilitychange", shown);
  document.addEventListener("resume", shown);
  window.addEventListener("focus", shown);
  window.addEventListener("pageshow", shown);
  window.addEventListener("online", shown);
  return () => {
    document.removeEventListener("visibilitychange", shown);
    document.removeEventListener("resume", shown);
    window.removeEventListener("focus", shown);
    window.removeEventListener("pageshow", shown);
    window.removeEventListener("online", shown);
  };
}
