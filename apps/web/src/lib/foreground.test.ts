// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { onForeground } from "./foreground.ts";

it("coalesces foreground events but refreshes again after another hidden trip", () => {
  const visible = vi.spyOn(document, "visibilityState", "get");
  visible.mockReturnValue("hidden");
  const refresh = vi.fn();
  const stop = onForeground(refresh);
  window.dispatchEvent(new Event("focus"));
  expect(refresh).not.toHaveBeenCalled();
  visible.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("pageshow"));
  expect(refresh).toHaveBeenCalledTimes(1);
  visible.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  visible.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(refresh).toHaveBeenCalledTimes(2);
  stop();
  document.dispatchEvent(new Event("resume"));
  expect(refresh).toHaveBeenCalledTimes(2);
  visible.mockRestore();
});
