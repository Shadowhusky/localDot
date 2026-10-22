import { expect, it, vi } from "vitest";
import { updateProgressReporter } from "./update-progress.ts";

it("writes to descriptor 3 only when the app asked, a step at a time, and stops when nobody listens", () => {
  expect(updateProgressReporter({})).toBeUndefined();
  expect(updateProgressReporter({ LOCALDOT_PROGRESS_FD: "4" })).toBeUndefined();
  const write = vi.fn();
  const report = updateProgressReporter({ LOCALDOT_PROGRESS_FD: "3" }, write);
  report?.({ step: "download", done: 1, total: 4 });
  report?.({ step: "download", done: 2, total: 4 });
  report?.({ step: "verify" });
  expect(write.mock.calls).toEqual([
    [3, '{"step":"download","done":1,"total":4}\n'],
    [3, '{"step":"verify"}\n'],
  ]);
  write.mockImplementation(() => {
    throw Object.assign(new Error("closed"), { code: "EPIPE" });
  });
  report?.({ step: "images", share: 0 });
  report?.({ step: "download" });
  expect(write).toHaveBeenCalledTimes(3);
});
