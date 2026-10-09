// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenForSessionLinks, takeSessionLink } from "./session-link.ts";

const SESSION = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
afterEach(() => window.history.replaceState(null, "", "/"));

describe("task links", () => {
  it("reads #session once, removes it and refuses anything but a task id", () => {
    window.history.replaceState(null, "", `/?replay=x#session=${SESSION}`);
    expect(takeSessionLink()).toBe(SESSION);
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?replay=x");
    window.history.replaceState(null, "", "/#session=../../x");
    expect(takeSessionLink()).toBeNull();
    window.history.replaceState(null, "", "/#code=abc");
    expect(takeSessionLink()).toBeNull();
    expect(window.location.hash).toBe("#code=abc");
  });

  it("opens from the starting address, a fragment change and a worker message", () => {
    window.history.replaceState(null, "", `/#session=${SESSION}`);
    const open = vi.fn();
    const worker = new EventTarget();
    const stop = listenForSessionLinks(open, window, worker as unknown as ServiceWorkerContainer);
    expect(open).toHaveBeenCalledWith(SESSION);
    window.location.hash = `session=${SESSION}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    worker.dispatchEvent(
      new MessageEvent("message", { data: { type: "open-session", sessionId: SESSION } }),
    );
    worker.dispatchEvent(
      new MessageEvent("message", { data: { type: "open-session", sessionId: "nope" } }),
    );
    expect(open).toHaveBeenCalledTimes(3);
    stop();
  });
});
