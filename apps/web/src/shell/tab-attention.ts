import type { AttentionLevel } from "@localdot/protocol";
import { useEffect, useSyncExternalStore } from "react";
import attentionIcon from "../favicon-attention.svg";
import type { Status } from "../session/status.ts";

// What waits for the user across tasks: how many, and the most urgent.
export interface TabAttention {
  count: number;
  top: AttentionLevel;
}

const NOTHING: TabAttention = { count: 0, top: "none" };
const WORDS: Partial<Record<AttentionLevel, string>> = {
  needs_you: "Needs you",
  blocked: "Paused",
  failed: "Failed",
  done: "Done",
};

const needsYou = (status: Status, attention: TabAttention) =>
  status.attention === "needs_you" || attention.top === "needs_you";

// Out of sight, the tab says what waits: the status' own words while dot needs you here, else the
// most urgent thing across tasks, counted once there is more than one. The amber point leads it
// whenever dot needs you.
export function tabTitle(status: Status, hidden: boolean, attention = NOTHING): string {
  if (!hidden) return status.title;
  const own = status.attention === "needs_you";
  const word = own ? status.label : WORDS[attention.top];
  if (!word) return status.title;
  const count = Math.max(attention.count, own ? 1 : 0);
  return `${needsYou(status, attention) ? "• " : ""}${count > 1 ? `(${count}) ` : ""}${word} · localDot`;
}

function watchVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

// The tab's title follows the status, and the tab's icon (the porcelain dot) gains the amber point
// at its corner while dot needs you out of sight.
export function useTabAttention(status: Status, attention = NOTHING) {
  const hidden = useSyncExternalStore(
    watchVisibility,
    () => document.hidden,
    () => false,
  );
  const title = tabTitle(status, hidden, attention);
  const marked = hidden && needsYou(status, attention);
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
