import {
  AttentionChangeEvent,
  type AttentionItem,
  type AttentionLevel,
  compareAttention,
  topAttention,
} from "@localdot/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { openSocket } from "../lib/socket.ts";
import { notifyApi } from "./notify-api.ts";
import { type PageNotificationHost, showPageNotification } from "./page-notifications.ts";

export interface AttentionView {
  // Open items across tasks, most urgent first.
  items: AttentionItem[];
  top: AttentionLevel;
  // The newest change that arrived live, not from a snapshot.
  latest: AttentionItem | null;
}

export interface AttentionOptions {
  WebSocketImpl?: typeof WebSocket;
  page?: PageNotificationHost;
  doc?: Pick<Document, "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener">;
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
}

const OPEN = new Set<AttentionLevel>(["needs_you", "blocked", "failed", "done"]);

export function applyChange(items: AttentionItem[], item: AttentionItem): AttentionItem[] {
  const others = items.filter((other) => other.sessionId !== item.sessionId);
  const next = OPEN.has(item.level) ? [...others, item] : others;
  return next.sort((a, b) => compareAttention(a.level, b.level) || b.at - a.at);
}

// The daemon's attention list for this tab, kept live over /api/events. The tab also reports
// whether someone is looking at it, and shows a notification itself when the daemon asks.
export function useAttention(
  api: ApiClient,
  openSession: (sessionId: string | null) => void,
  opts: AttentionOptions = {},
): AttentionView {
  const [state, setState] = useState<{ items: AttentionItem[]; latest: AttentionItem | null }>({
    items: [],
    latest: null,
  });
  const shown = useRef(new Set<string>());
  const open = useRef(openSession);
  open.current = openSession;

  useEffect(() => {
    let cancelled = false;
    let opened = false;
    const doc = opts.doc ?? document;
    const win = opts.win ?? window;
    const page: PageNotificationHost = opts.page ?? {
      ...(typeof Notification === "undefined" ? {} : { Notification }),
      focus: () => window.focus(),
      openSession: (id) => open.current(id),
    };
    // A snapshot replaces the list; changes that arrive while it is on its way go on top of it.
    let since: AttentionItem[] | null = null;
    const load = () => {
      const changes: AttentionItem[] = [];
      since = changes;
      notifyApi(api)
        .attention()
        .then((snapshot) => {
          if (cancelled || since !== changes) return;
          since = null;
          setState((current) => ({
            ...current,
            items: changes.reduce(applyChange, snapshot.reduce(applyChange, [])),
          }));
        })
        .catch(() => {
          if (since === changes) since = null;
        });
    };
    // A visible window behind another app is not being looked at either.
    const looking = () => doc.visibilityState === "visible" && doc.hasFocus();
    const presence = () =>
      JSON.stringify({
        type: "presence",
        visible: looking(),
        canNotify: page.Notification?.permission === "granted",
      });
    load();
    const socket = openSocket({
      url: api.socketUrl("/api/events"),
      protocols: api.socketProtocols(),
      ...(opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}),
      handlers: {
        onOpen: () => {
          socket.send(presence());
          // What changed while the connection was down is only in a fresh snapshot.
          if (opened) load();
          opened = true;
        },
        onMessage: (data) => {
          let value: unknown;
          try {
            value = JSON.parse(data);
          } catch {
            return;
          }
          const parsed = AttentionChangeEvent.safeParse(value);
          if (!parsed.success) return;
          const { item, page: fromPage } = parsed.data;
          since?.push(item);
          setState((current) => ({ items: applyChange(current.items, item), latest: item }));
          if (fromPage && !looking() && showPageNotification(item, shown.current, page) === "shown")
            socket.send(JSON.stringify({ type: "shown", key: item.key }));
        },
      },
    });
    const report = () => {
      socket.send(presence());
    };
    doc.addEventListener("visibilitychange", report);
    win.addEventListener("focus", report);
    win.addEventListener("blur", report);
    return () => {
      cancelled = true;
      socket.close();
      doc.removeEventListener("visibilitychange", report);
      win.removeEventListener("focus", report);
      win.removeEventListener("blur", report);
    };
  }, [api, opts.WebSocketImpl, opts.page, opts.doc, opts.win]);

  return useMemo(
    () => ({
      items: state.items,
      top: topAttention(state.items.map((item) => item.level)),
      latest: state.latest,
    }),
    [state],
  );
}
