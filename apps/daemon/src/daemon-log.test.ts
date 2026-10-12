import { expect, it, vi } from "vitest";
import { timestampLogs } from "./daemon-log.ts";

it("timestamps each severity without discarding its original details", () => {
  const writes = { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    target = { ...writes };
  timestampLogs(target, () => "2026-10-12T03:00:00.000Z");
  target.error("daemon cleanup failed: agent", "timeout");
  expect(writes.error).toHaveBeenCalledWith(
    "[2026-10-12T03:00:00.000Z]",
    "daemon cleanup failed: agent",
    "timeout",
  );
  target.log("ready");
  target.warn("pending");
  expect(writes.log).toHaveBeenCalledWith("[2026-10-12T03:00:00.000Z]", "ready");
  expect(writes.warn).toHaveBeenCalledWith("[2026-10-12T03:00:00.000Z]", "pending");
});
