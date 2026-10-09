import { DEFAULT_NOTIFY_SETTINGS, type NotifySettings } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { decide, inQuietHours, type Notice, noticeOf } from "./policy.ts";

const SESSION = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
const away = { localVisible: false, localHiddenCanNotify: false };
const needsYou: Notice = {
  key: `${SESSION}:approval:x:1:1`,
  event: "needs_you",
  kind: "needs_you",
  sessionId: SESSION,
  detail: "Pay the electricity bill",
};
const done: Notice = { ...needsYou, key: `${SESSION}:done:9`, event: "done", kind: "done" };
const quiet = (allowNeedsYou: boolean): NotifySettings => ({
  ...DEFAULT_NOTIFY_SETTINGS,
  quietHours: { enabled: true, start: "22:00", end: "07:00", allowNeedsYou },
});
// 23:30 in London on 8 October 2026 (BST, UTC+1).
const night = new Date("2026-10-08T22:30:00Z");
const noon = new Date("2026-10-08T11:00:00Z");

describe("delivery policy", () => {
  it("sends Needs you to the Mac and the phone with only kind and session by default", () => {
    expect(decide(needsYou, DEFAULT_NOTIFY_SETTINGS, away, noon, "Europe/London")).toEqual({
      mac: "banner",
      phone: true,
      macTitle: "dot needs you",
      macBody: "Pay the electricity bill",
      payload: { kind: "needs_you", sessionId: SESSION },
      ttl: 600,
      urgency: "high",
    });
  });

  it("adds the task's title to the phone only when the user opted in", () => {
    const settings = { ...DEFAULT_NOTIFY_SETTINGS, showTaskText: true };
    expect(decide(needsYou, settings, away, noon, "Europe/London")?.payload).toEqual({
      kind: "needs_you",
      sessionId: SESSION,
      title: "Pay the electricity bill",
    });
  });

  it("quiet hours suppress Done and keep Needs you, which can be turned off", () => {
    expect(decide(done, quiet(true), away, night, "Europe/London")).toBeNull();
    expect(decide(needsYou, quiet(true), away, night, "Europe/London")).toMatchObject({
      mac: "banner",
      phone: true,
    });
    expect(decide(needsYou, quiet(false), away, night, "Europe/London")).toBeNull();
    expect(decide(done, quiet(true), away, noon, "Europe/London")).not.toBeNull();
  });

  it("uses the Mac's zone and windows that cross midnight", () => {
    const window = quiet(true).quietHours;
    expect(inQuietHours(window, night, "Europe/London")).toBe(true);
    expect(inQuietHours(window, night, "America/New_York")).toBe(false);
    expect(inQuietHours(window, new Date("2026-10-09T05:59:00Z"), "Europe/London")).toBe(true);
    expect(inQuietHours(window, new Date("2026-10-09T06:00:00Z"), "Europe/London")).toBe(false);
    expect(inQuietHours({ ...window, start: "09:00", end: "17:00" }, noon, "Europe/London")).toBe(
      true,
    );
    expect(inQuietHours({ ...window, enabled: false }, night, "Europe/London")).toBe(false);
  });

  it("routes the Mac by who is looking", () => {
    expect(
      decide(
        needsYou,
        DEFAULT_NOTIFY_SETTINGS,
        { localVisible: true, localHiddenCanNotify: true },
        noon,
        "UTC",
      )?.mac,
    ).toBe("none");
    expect(
      decide(
        needsYou,
        DEFAULT_NOTIFY_SETTINGS,
        { localVisible: false, localHiddenCanNotify: true },
        noon,
        "UTC",
      )?.mac,
    ).toBe("page");
  });

  it("follows each event's switches", () => {
    const settings: NotifySettings = {
      ...DEFAULT_NOTIFY_SETTINGS,
      events: { ...DEFAULT_NOTIFY_SETTINGS.events, done: { mac: false, phone: true } },
    };
    expect(decide(done, settings, away, noon, "UTC")).toMatchObject({ mac: "none", phone: true });
    const off = { ...settings, events: { ...settings.events, done: { mac: false, phone: false } } };
    expect(decide(done, off, away, noon, "UTC")).toBeNull();
  });

  it("titles a routine's Mac banner with the routine's own words", () => {
    const routine: Notice = {
      key: "routine:r1:done",
      event: "routine",
      kind: "routine",
      sessionId: null,
      detail: "Morning bills: 2 new statements",
    };
    expect(decide(routine, DEFAULT_NOTIFY_SETTINGS, away, noon, "UTC")).toMatchObject({
      macTitle: "Morning bills: 2 new statements",
      macBody: "Open localDot to see the result.",
      payload: { kind: "routine", sessionId: null },
    });
  });

  it("maps attention reasons to rows and push kinds", () => {
    const item = { key: "k", sessionId: SESSION, level: "blocked" as const, task: null, at: 1 };
    expect(noticeOf({ ...item, reason: "budget" })).toMatchObject({
      event: "failed",
      kind: "blocked",
    });
    expect(noticeOf({ ...item, reason: "gave_up" })).toMatchObject({
      event: "failed",
      kind: "failed",
    });
    expect(noticeOf({ ...item, reason: "working" })).toBeNull();
    expect(noticeOf({ ...item, reason: "cleared" })).toBeNull();
  });
});
