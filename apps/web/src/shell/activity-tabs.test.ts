// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { onActivityTab, showActivityTab } from "./activity-tabs.ts";

it("hands a tab asked for to Activity at once, or as it comes onto the page", () => {
  showActivityTab("files");
  const early = vi.fn();
  const stop = onActivityTab(early);
  expect(early).toHaveBeenCalledWith("files");
  showActivityTab("previews");
  expect(early.mock.calls).toEqual([["files"], ["previews"]]);
  stop();
  const late = vi.fn();
  onActivityTab(late)();
  expect(late).not.toHaveBeenCalled();
});
