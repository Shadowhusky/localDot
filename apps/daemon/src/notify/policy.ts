import {
  type AttentionItem,
  NOTIFY_COPY,
  type NotifyEvent,
  type NotifySettings,
  notifyRouteOf,
  type PushKind,
  type PushPayload,
  type QuietHours,
} from "@localdot/protocol";
import type { PresenceSnapshot } from "./presence.ts";

// One thing worth telling the user about. detail is the user's own words (the task's title, a
// routine's name and outcome): the Mac shows it, a phone only when "Show task text" is on.
export interface Notice {
  key: string;
  event: NotifyEvent;
  kind: PushKind;
  sessionId: string | null;
  detail: string | null;
}

export type MacRoute = "banner" | "page" | "none";

export interface Delivery {
  mac: MacRoute;
  phone: boolean;
  macTitle: string;
  macBody: string;
  payload: PushPayload;
  ttl: number;
  urgency: "normal" | "high";
}

export function noticeOf(item: AttentionItem): Notice | null {
  const route = notifyRouteOf(item.reason);
  if (!route) return null;
  return { key: item.key, ...route, sessionId: item.sessionId, detail: item.task };
}

// The Mac's local time decides, whatever zone the phone is in. A window may cross midnight.
export function inQuietHours(quiet: QuietHours, now: Date, timeZone: string): boolean {
  if (!quiet.enabled) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const minute = value("hour") * 60 + value("minute");
  const [start, end] = [quiet.start, quiet.end].map((time) => {
    const [h, m] = time.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  }) as [number, number];
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function decide(
  notice: Notice,
  settings: NotifySettings,
  presence: PresenceSnapshot,
  now: Date,
  timeZone: string,
): Delivery | null {
  const channels = settings.events[notice.event];
  const quiet =
    inQuietHours(settings.quietHours, now, timeZone) &&
    !(notice.event === "needs_you" && settings.quietHours.allowNeedsYou);
  const mac: MacRoute =
    !channels.mac || quiet || presence.localVisible
      ? "none"
      : presence.localHiddenCanNotify
        ? "page"
        : "banner";
  const phone = channels.phone && !quiet;
  if (mac === "none" && !phone) return null;
  const copy = NOTIFY_COPY[notice.kind];
  // A routine's banner carries its own words as the title ("Morning bills: 2 new statements").
  const routineTitle = notice.kind === "routine" ? notice.detail : null;
  return {
    mac,
    phone,
    macTitle: routineTitle ?? copy.title,
    macBody: routineTitle ? copy.body : (notice.detail ?? copy.body),
    payload: {
      kind: notice.kind,
      sessionId: notice.sessionId,
      ...(settings.showTaskText && notice.detail ? { title: notice.detail } : {}),
    },
    ttl: notice.kind === "needs_you" ? 600 : 4 * 60 * 60,
    urgency: notice.kind === "needs_you" ? "high" : "normal",
  };
}
