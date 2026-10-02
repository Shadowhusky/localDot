import { describe, expect, it, vi } from "vitest";
import { LiveSessions } from "./live.ts";

describe("live session settlement", () => {
  it("registers before callbacks run and handles reentrant Stop", async () => {
    const live = new LiveSessions();
    live.start("cell", "session", async (signal) => {
      expect(live.get("cell")).toBe("session");
      const aborted = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve()),
      );
      expect(live.stop("session")).toBe(true);
      await aborted;
    });
    await live.settled("session");
    expect(live.get("cell")).toBeUndefined();
    await live.settled("already-finished");
  });

  it("settles synchronous throws without exposing exception contents", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const live = new LiveSessions();
      live.start("cell", "session", () => {
        throw new Error("private-input");
      });
      await live.settled("session");
      expect(live.get("cell")).toBeUndefined();
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-input");
    } finally {
      log.mockRestore();
    }
  });

  it("rejects an ambiguous session id shared by two computers", async () => {
    const live = new LiveSessions();
    live.start(
      "first",
      "session",
      (signal) => new Promise((resolve) => signal.addEventListener("abort", resolve)),
    );
    expect(() => live.start("second", "session", async () => {})).toThrow("already live");
    live.stop("session");
    await live.settled("session");
  });
});
