import { expect, it, vi } from "vitest";
import { displayLogLine, timestampLogs } from "./daemon-log.ts";

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
it("escapes terminal/bidi controls and masks recognizable credential forms", () => {
  const raw = `\u001b]52;c;clipboard\u0007 \u202ereverse Bearer private-value #code=code-value token="private token" sk-provider-private ld_abc_${"a".repeat(22)}_${"b".repeat(6)}`;
  const output = displayLogLine(raw);
  for (const value of [
    "\u001b",
    "\u0007",
    "\u202e",
    "private-value",
    "code-value",
    "private token",
    "sk-provider-private",
    `ld_abc_${"a".repeat(22)}`,
  ])
    expect(output).not.toContain(value);
  expect(output).toContain("\\u001b");
  expect(output).toContain("[redacted]");
});
