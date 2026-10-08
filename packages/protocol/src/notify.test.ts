import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFY_SETTINGS,
  NOTIFY_COPY,
  NotifySettings,
  notifyRouteOf,
  PushPayload,
  PushSubscriptionInput,
  pushServiceOf,
} from "./notify.ts";

const P256DH = `B${"A".repeat(86)}`;
const AUTH = "A".repeat(22);

describe("notify protocol", () => {
  it("accepts only the browsers' push services", () => {
    expect(pushServiceOf("https://web.push.apple.com/QGuR")).toBe("Apple");
    expect(pushServiceOf("https://fcm.googleapis.com/fcm/send/abc")).toBe("Google");
    expect(pushServiceOf("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe("Mozilla");
    expect(pushServiceOf("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe("Microsoft");
    for (const bad of [
      "http://web.push.apple.com/x",
      "https://web.push.apple.com:8443/x",
      "https://push.apple.com.evil.example/x",
      "https://user@web.push.apple.com/x",
      "https://web.push.apple.com/x#frag",
      "https://127.0.0.1/x",
      "not a url",
    ])
      expect(pushServiceOf(bad), bad).toBeNull();
  });

  it("validates a subscription and trims its label", () => {
    const ok = PushSubscriptionInput.parse({
      endpoint: "https://web.push.apple.com/QGuR",
      keys: { p256dh: P256DH, auth: AUTH },
      label: "  iPhone ",
    });
    expect(ok.label).toBe("iPhone");
    for (const bad of [
      { endpoint: "https://evil.example/x", keys: { p256dh: P256DH, auth: AUTH }, label: "x" },
      {
        endpoint: "https://web.push.apple.com/x",
        keys: { p256dh: "short", auth: AUTH },
        label: "x",
      },
      {
        endpoint: "https://web.push.apple.com/x",
        keys: { p256dh: P256DH, auth: AUTH },
        label: " ",
      },
      {
        endpoint: "https://web.push.apple.com/x",
        keys: { p256dh: P256DH, auth: AUTH },
        label: "x",
        extra: 1,
      },
    ])
      expect(PushSubscriptionInput.safeParse(bad).success).toBe(false);
  });

  it("defaults to every event on both channels, no quiet hours and no task text", () => {
    expect(NotifySettings.parse(DEFAULT_NOTIFY_SETTINGS)).toEqual(DEFAULT_NOTIFY_SETTINGS);
    expect(DEFAULT_NOTIFY_SETTINGS.showTaskText).toBe(false);
    expect(
      NotifySettings.safeParse({
        ...DEFAULT_NOTIFY_SETTINGS,
        quietHours: { enabled: true, start: "22:00", end: "22:00", allowNeedsYou: true },
      }).success,
    ).toBe(false);
  });

  it("keeps the payload to kind, session and an optional title", () => {
    expect(PushPayload.safeParse({ kind: "needs_you", sessionId: null, text: "x" }).success).toBe(
      false,
    );
  });

  it("routes reasons to Settings rows and push kinds; working and cleared notify nobody", () => {
    expect(notifyRouteOf("approval")).toEqual({ event: "needs_you", kind: "needs_you" });
    expect(notifyRouteOf("budget")).toEqual({ event: "failed", kind: "blocked" });
    expect(notifyRouteOf("gave_up")).toEqual({ event: "failed", kind: "failed" });
    expect(notifyRouteOf("working")).toBeNull();
    expect(notifyRouteOf("cleared")).toBeNull();
    expect(NOTIFY_COPY.needs_you.title).toBe("dot needs you");
  });
});
