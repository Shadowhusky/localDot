import { useEffect, useSyncExternalStore } from "react";
import attentionIcon from "../favicon-attention.svg";
import type { Status } from "../session/status.ts";

const needsYou = (status: Status, hidden: boolean) => hidden && status.attention === "needs_you";

// While dot needs you and the tab is out of sight, the amber point leads its title.
export function tabTitle(status: Status, hidden: boolean): string {
  return needsYou(status, hidden) ? `• ${status.label} · localDot` : status.title;
}

function watchVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

// The tab's title follows the status, and the tab's icon (the porcelain dot) gains the amber point
// at its corner while dot needs you out of sight.
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
    link.setAttribute("href", attentionIcon);
    return () => {
      if (plain === null) link.removeAttribute("href");
      else link.setAttribute("href", plain);
    };
  }, [marked]);
}
