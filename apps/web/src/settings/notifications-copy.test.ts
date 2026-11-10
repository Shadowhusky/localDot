import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api.ts";
import {
  deviceCopy,
  deviceDetail,
  errorLine,
  MAC_BANNER_HINT,
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
      `Sent to this Mac. ${MAC_BANNER_HINT}`,
    );
    expect(testResultLine({ mac: "shown", phones: [phone("iPhone", "sent")] })).toBe(
      `Sent to this Mac and 1 phone. ${MAC_BANNER_HINT}`,
    );
    expect(testResultLine({ mac: "failed", phones: [phone("Old phone", "gone")] })).toBe(
      `The Mac banner didn't show. Old phone stopped accepting notifications and was removed. ${MAC_BANNER_HINT}`,
    );
    // The banner comes from localDot's own helper app, which is what System Settings lists.
    expect(MAC_BANNER_HINT).toBe(
      "No banner on the Mac? Allow notifications for localDot in System Settings › Notifications.",
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

  it("steers a Home Screen install away from an address an iPhone doesn't trust", () => {
    expect(deviceCopy({ kind: "needs-home-screen" }).line).not.toMatch(/certificate/);
    const { line, action } = deviceCopy({ kind: "needs-home-screen", bareAddress: true });
    expect(line).toMatch(/Tailscale link/);
    expect(line).toMatch(/certificate/);
    expect(line).toMatch(/Add to Home Screen/);
    expect(action).toBe("copy-link");
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
