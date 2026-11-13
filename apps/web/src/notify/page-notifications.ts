import { type AttentionItem, notifyRouteOf } from "@localdot/protocol";
import { notifyCopy } from "./notify-words.ts";

export interface PageNotificationHost {
  Notification?: {
    permission: NotificationPermission;
    new (title: string, options: NotificationOptions): Notification;
  };
  // The service worker's, when the page has one: its tap goes where a push's does.
  show?(title: string, options: NotificationOptions): Promise<void>;
  focus(): void;
  openSession(sessionId: string | null): void;
}

// Shows a notification from this tab when the daemon asks for one: an open but hidden tab on this
// Mac can open the task on a click, which the daemon's own banner cannot. Each key shows once.
export function showPageNotification(
  item: AttentionItem,
  shown: Set<string>,
  host: PageNotificationHost,
): "shown" | "skipped" | "failed" {
  const route = notifyRouteOf(item.reason);
  if (!route || shown.has(item.key)) return "skipped";
  if (host.Notification?.permission !== "granted") return "skipped";
  shown.add(item.key);
  const copy = notifyCopy(route.kind);
  const body = item.task ?? copy.body;
  if (host.show) {
    // The push to this Mac for the same task carries the same tag: the two are one notification.
    const options = { body, tag: `${route.kind}:${item.sessionId ?? "none"}` };
    void host.show(copy.title, { ...options, data: { sessionId: item.sessionId } }).catch(() => {
      try {
        if (host.Notification) new host.Notification(copy.title, options);
      } catch {}
    });
    return "shown";
  }
  try {
    const notification = new host.Notification(copy.title, { body, tag: item.key });
    notification.onclick = () => {
      notification.close();
      host.focus();
      host.openSession(item.sessionId);
    };
    return "shown";
  } catch {
    return "failed";
  }
}
