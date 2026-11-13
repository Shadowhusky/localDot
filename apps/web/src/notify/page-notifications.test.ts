import type { AttentionItem } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { type PageNotificationHost, showPageNotification } from "./page-notifications.ts";

const SESSION = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
const item: AttentionItem = {
  key: `${SESSION}:approval:a:1:1`,
  sessionId: SESSION,
  level: "needs_you",
  reason: "approval",
  task: "Pay the electricity bill",
  at: 1,
};

function host(permission: NotificationPermission = "granted", fail = false) {
  const made: {
    title: string;
    options: NotificationOptions;
    onclick: (() => void) | null;
    close: () => void;
  }[] = [];
  class Fake {
    static permission = permission;
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(
      public title: string,
      public options: NotificationOptions,
    ) {
      if (fail) throw new Error("blocked");
      made.push(this);
    }
  }
  const h: PageNotificationHost = {
    Notification: Fake as unknown as PageNotificationHost["Notification"],
    focus: vi.fn(),
    openSession: vi.fn(),
  };
  return { made, h };
}

describe("page notifications", () => {
  it("shows the daemon's copy once per key, and a click opens the task", () => {
    const { made, h } = host();
    const shown = new Set<string>();
    expect(showPageNotification(item, shown, h)).toBe("shown");
    expect(showPageNotification(item, shown, h)).toBe("skipped");
    expect(made).toHaveLength(1);
    expect(made[0]?.title).toBe("dot needs you");
    expect(made[0]?.options).toEqual({ body: "Pay the electricity bill", tag: item.key });
    made[0]?.onclick?.();
    expect(h.focus).toHaveBeenCalledOnce();
    expect(h.openSession).toHaveBeenCalledWith(SESSION);
  });

  it("skips without permission or for states that notify nobody, and survives a refusal", () => {
    expect(showPageNotification(item, new Set(), host("default").h)).toBe("skipped");
    expect(
      showPageNotification({ ...item, reason: "working", level: "working" }, new Set(), host().h),
    ).toBe("skipped");
    expect(showPageNotification(item, new Set(), host("granted", true).h)).toBe("failed");
  });

  // Shown through the service worker, a tap goes where the worker takes a push's: to the installed
  // app's window when one is open, not to whichever tab showed it. It shares the push's tag, so the
  // two for one task are one notification.
  it("goes through the service worker when the page has one", () => {
    const { made, h } = host();
    const show = vi.fn(async () => {});
    expect(showPageNotification(item, new Set(), { ...h, show })).toBe("shown");
    expect(made).toHaveLength(0);
    expect(show).toHaveBeenCalledWith("dot needs you", {
      body: "Pay the electricity bill",
      tag: `needs_you:${SESSION}`,
      data: { sessionId: SESSION },
    });
  });
});
