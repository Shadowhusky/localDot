import { useEffect, useSyncExternalStore } from "react";
import type { Status } from "../session/status.ts";

// The favicon's porcelain dot with the amber point at its corner.
const ATTENTION_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0a0b0d"/><circle cx="15" cy="17" r="7" fill="#eeeff1"/><circle cx="25" cy="7" r="5.5" fill="#e9b44c" stroke="#0a0b0d" stroke-width="2"/></svg>',
)}`;

const needsYou = (status: Status, hidden: boolean) => hidden && status.attention === "needs_you";

// While dot needs you and the tab is out of sight, the amber point leads its title.
export function tabTitle(status: Status, hidden: boolean): string {
  return needsYou(status, hidden) ? `• ${status.label} · localDot` : status.title;
}

function watchVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

// The tab's title follows the status, and the tab's icon gains the amber point while dot needs
// you out of sight.
export function useTabAttention(status: Status) {
  const hidden = useSyncExternalStore(
    watchVisibility,
    () => document.hidden,
    () => false,
  );
  const title = tabTitle(status, hidden);
  const marked = needsYou(status, hidden);
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (!marked || !link) return;
    const plain = link.getAttribute("href");
    link.setAttribute("href", ATTENTION_ICON);
    return () => {
      if (plain === null) link.removeAttribute("href");
      else link.setAttribute("href", plain);
    };
  }, [marked]);
}
