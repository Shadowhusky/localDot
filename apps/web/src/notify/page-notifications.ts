import { type AttentionItem, NOTIFY_COPY, notifyRouteOf } from "@localdot/protocol";

export interface PageNotificationHost {
  Notification?: {
    permission: NotificationPermission;
    new (title: string, options: NotificationOptions): Notification;
  };
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
  const copy = NOTIFY_COPY[route.kind];
  try {
    const notification = new host.Notification(copy.title, {
      body: item.task ?? copy.body,
      tag: item.key,
    });
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
