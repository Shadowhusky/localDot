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

  it("opens the task a banner's link names in the window the installed app already has", () => {
    const open = vi.fn();
    let consumer: ((params: { targetURL?: string }) => void) | undefined;
    const stop = listenForSessionLinks(open, window, undefined, {
      setConsumer: (given) => {
        consumer = given;
      },
    });
    consumer?.({ targetURL: `http://127.0.0.1:4750/#session=${SESSION}` });
    consumer?.({ targetURL: "http://127.0.0.1:4750/#session=nope" });
    consumer?.({ targetURL: "http://127.0.0.1:4750/" });
    expect(open).toHaveBeenCalledExactlyOnceWith(SESSION);
    stop();
    consumer?.({ targetURL: `http://127.0.0.1:4750/#session=${SESSION}` });
    expect(open).toHaveBeenCalledOnce();
  });

  it("tells the worker whether this window is the installed app's", async () => {
    for (const standalone of [true, false]) {
      const worker = new EventTarget();
      const stop = listenForSessionLinks(
        vi.fn(),
        window,
        worker as unknown as ServiceWorkerContainer,
        undefined,
        () => standalone,
      );
      const { port1, port2 } = new MessageChannel();
      const answer = new Promise((resolve) => {
        port1.onmessage = (event) => resolve(event.data);
      });
      worker.dispatchEvent(
        new MessageEvent("message", { data: { type: "display-mode" }, ports: [port2] }),
      );
      expect(await answer).toEqual({ standalone });
      port1.close();
      stop();
    }
  });
});
