import { type AttentionItem, NOTIFY_COPY, notifyRouteOf } from "@localdot/protocol";
import { useEffect, useRef } from "react";
import { dismissToast, showToast } from "../ui/Toast.tsx";
import type { ToastOptions } from "../ui/toasts.ts";

export interface AttentionToastHost {
  show(options: ToastOptions): void;
  dismiss(id: string): void;
  hidden(): boolean;
}

const HOST: AttentionToastHost = {
  show: showToast,
  dismiss: dismissToast,
  hidden: () => document.hidden,
};

// Where the user is: the task on screen, and whether the island (which toasts hang from) is.
export interface AttentionPlace {
  viewing: string | null;
  island: boolean;
}

// A task other than the one on screen that needs you, finishes or fails says so from the island,
// with Open. A hidden tab leaves it to notifications; a task that moves on takes its toast back.
export function useAttentionToasts(
  latest: AttentionItem | null,
  place: AttentionPlace,
  open: (sessionId: string) => void,
  host: AttentionToastHost = HOST,
): void {
  const now = useRef({ place, open, host });
  now.current = { place, open, host };
  useEffect(() => {
    const sessionId = latest?.sessionId;
    if (!latest || !sessionId) return;
    const { place, host } = now.current;
    const id = `attention:${sessionId}`;
    const route = notifyRouteOf(latest.reason);
    if (!route) return host.dismiss(id);
    if (sessionId === place.viewing || !place.island || host.hidden()) return;
    const copy = NOTIFY_COPY[route.kind];
    host.show({
      id,
      title: copy.title,
      ...(latest.task ? { description: latest.task } : {}),
      tone: latest.level === "failed" ? "danger" : "neutral",
      action: { label: "Open", onAction: () => now.current.open(sessionId) },
    });
  }, [latest]);
}
