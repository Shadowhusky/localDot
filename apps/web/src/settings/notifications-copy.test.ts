import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api.ts";
import {
  deviceCopy,
  deviceDetail,
  errorLine,
  SCRIPT_EDITOR_HINT,
  testResultLine,
} from "./notifications-copy.ts";

const phone = (label: string, result: "sent" | "gone" | "failed") => ({
  id: "0123456789abcdef",
  label,
  result,
});

describe("notifications copy", () => {
  it("always tells the user where to allow Mac banners after one was sent", () => {
    expect(testResultLine({ mac: "shown", phones: [] })).toBe(
      `Sent to this Mac. ${SCRIPT_EDITOR_HINT}`,
    );
    expect(testResultLine({ mac: "shown", phones: [phone("iPhone", "sent")] })).toBe(
      `Sent to this Mac and 1 phone. ${SCRIPT_EDITOR_HINT}`,
    );
    expect(testResultLine({ mac: "failed", phones: [phone("Old phone", "gone")] })).toBe(
      `The Mac banner didn't show. Old phone stopped accepting notifications and was removed. ${SCRIPT_EDITOR_HINT}`,
    );
  });

  it("counts phones in words and says when nothing was sent", () => {
    expect(
      testResultLine({ mac: "unavailable", phones: [phone("A", "sent"), phone("B", "sent")] }),
    ).toBe("Sent to 2 phones.");
    expect(testResultLine({ mac: "unavailable", phones: [] })).toBe(
      "Nothing was sent: no phones are set up yet.",
    );
    expect(testResultLine({ mac: "unavailable", phones: [phone("iPad", "failed")] })).toBe(
      "iPad didn't get it. Check its connection and try again.",
    );
  });

  it("explains each device state and offers one action", () => {
    expect(deviceCopy({ kind: "off" })).toEqual({ line: "Off on this device.", action: "turn-on" });
    expect(deviceCopy({ kind: "on", id: "x" }).action).toBe("turn-off");
    expect(deviceCopy({ kind: "needs-home-screen" }).action).toBe("copy-link");
    expect(deviceCopy({ kind: "this-mac" }).action).toBeNull();
  });

  it("turns failures into plain sentences, never raw errors", () => {
    expect(errorLine(new ApiError(503, "the key layer is offline"))).toMatch(/key protection/);
    expect(
      errorLine(
        new ApiError(409, "Notifications can be on for up to 10 devices. Remove one first."),
      ),
    ).toBe("Notifications can be on for up to 10 devices. Remove one first.");
    expect(errorLine(new DOMException("x", "NotAllowedError"))).toBe(
      "Notifications weren't allowed on this device.",
    );
    expect(errorLine(new TypeError("fetch failed"))).toBe("That didn't work. Try again.");
  });

  it("describes a device by when it was added", () => {
    expect(
      deviceDetail({
        id: "0123456789abcdef",
        label: "iPhone",
        service: "Apple",
        createdAt: "2026-10-03T09:00:00Z",
        lastSentAt: null,
        lastResult: "failed",
      }),
    ).toBe("Added 3 Oct · Last message failed");
  });
});
