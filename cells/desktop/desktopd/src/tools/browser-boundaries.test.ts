import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { fakeCdp, fakeTargets } from "../testing/fake-cdp.ts";
import { NavigationError, NoPageError, PageBrowser } from "./browser.ts";

afterEach(() => vi.useRealTimers());

describe("page tool boundaries", () => {
  it("rejects non-web navigation before discovering or opening a page", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const browser = new PageBrowser({ fetchImpl });
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,hello",
      "file:///config/a",
      "chrome://settings",
      "devtools://x",
    ])
      await expect(browser.navigate(url)).rejects.toThrow(NavigationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("opens only a debugger socket on the configured cell loopback port", async () => {
    const { WebSocketImpl, sent } = fakeCdp(() => ({}));
    for (const socket of [
      "ws://example.com:9222/devtools/page/a",
      "ws://127.0.0.1:9223/devtools/page/a",
      "ws://user@127.0.0.1:9222/devtools/page/a",
      "wss://127.0.0.1:9222/devtools/page/a",
      "ws://127.0.0.1:9222/other",
    ]) {
      const fetchImpl = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify([
              { type: "page", url: "https://example.com/", webSocketDebuggerUrl: socket },
            ]),
          ),
      );
      await expect(new PageBrowser({ fetchImpl, WebSocketImpl }).read(500)).rejects.toThrow(
        NoPageError,
      );
    }
    expect(sent).toEqual([]);
  });

  it("does not accept the old complete document for a same-URL reload with a loader", async () => {
    let navigated = false;
    const { WebSocketImpl } = fakeCdp((method) => {
      if (method === "Page.navigate") {
        navigated = true;
        return { loaderId: "new-loader" };
      }
      return {
        result: {
          value: {
            url: "https://example.com/",
            title: navigated ? "still old" : "before",
            ready: "complete",
            origin: 1,
          },
        },
      };
    });
    const browser = new PageBrowser({
      WebSocketImpl,
      fetchImpl: fakeTargets([{ type: "page", url: "https://example.com/" }]),
      loadTimeoutMs: 10,
    });
    expect(await browser.navigate("https://example.com/")).toEqual({
      url: "https://example.com/",
      title: "still old",
      loaded: false,
    });
  });

  it("accepts a completed same-document fragment navigation without a new loader", async () => {
    let navigated = false;
    const { WebSocketImpl } = fakeCdp((method) => {
      if (method === "Page.navigate") {
        navigated = true;
        return {};
      }
      return {
        result: {
          value: {
            url: `https://example.com/${navigated ? "#section" : ""}`,
            title: "Example",
            ready: "complete",
            origin: 1,
          },
        },
      };
    });
    const browser = new PageBrowser({
      WebSocketImpl,
      fetchImpl: fakeTargets([{ type: "page", url: "https://example.com/" }]),
      loadTimeoutMs: 20,
    });
    expect(await browser.navigate("https://example.com/#section")).toMatchObject({
      url: "https://example.com/#section",
      loaded: true,
    });
  });

  it("refuses navigation when the original document cannot be identified", async () => {
    const { WebSocketImpl, sent } = fakeCdp(() => ({ result: { value: { ready: "complete" } } }));
    const browser = new PageBrowser({
      WebSocketImpl,
      fetchImpl: fakeTargets([{ type: "page", url: "about:blank" }]),
    });
    await expect(browser.navigate("https://example.com/")).rejects.toThrow(/establish/);
    expect(sent).not.toContain("Page.navigate");
  });

  it("keeps bounded page text when the optional accessibility tree fails", async () => {
    const { WebSocketImpl } = fakeCdp((method) => {
      if (method === "Runtime.evaluate")
        return {
          result: {
            value: { url: "https://example.com/", title: "Example", text: "abc", truncated: true },
          },
        };
      throw new Error("accessibility unavailable");
    });
    const browser = new PageBrowser({
      WebSocketImpl,
      fetchImpl: fakeTargets([{ type: "page", url: "https://example.com/" }]),
    });
    expect(await browser.read(3)).toMatchObject({ text: "abc", truncated: true, outline: "" });
  });

  it("cancels target discovery and never opens a socket if a late target arrives", async () => {
    let answer!: (value: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { WebSocketImpl, sent } = fakeCdp(() => ({}));
    const abort = new AbortController();
    const pending = new PageBrowser({ fetchImpl, WebSocketImpl }).navigate(
      "https://example.com/",
      abort.signal,
    );
    const rejected = expect(pending).rejects.toThrow("stopped");
    abort.abort(new Error("stopped"));
    await rejected;
    answer(await fakeTargets([{ type: "page", url: "about:blank" }])("http://fixture"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual([]);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("closes a hung CDP operation on caller abort without subsequent page commands", async () => {
    let closed = 0;
    let dispatched!: () => void;
    const sent: string[] = [];
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    class Socket extends EventEmitter {
      readyState = 0;
      constructor() {
        super();
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit("open");
        });
      }
      send(data: string) {
        sent.push(JSON.parse(data).method);
        dispatched();
      }
      close() {
        if (this.readyState === 3) return;
        closed++;
        this.readyState = 3;
        this.emit("close");
      }
      terminate() {
        this.close();
      }
    }
    const abort = new AbortController();
    const browser = new PageBrowser({
      WebSocketImpl: Socket as unknown as typeof WebSocket,
      fetchImpl: fakeTargets([{ type: "page", url: "about:blank" }]),
    });
    const pending = browser.navigate("https://example.com/", abort.signal);
    const rejected = expect(pending).rejects.toThrow("stopped");
    await started;
    abort.abort(new Error("stopped"));
    await rejected;
    await Promise.resolve();
    expect(closed).toBe(1);
    expect(sent).toEqual(["Runtime.evaluate"]);
  });

  it("enforces a whole-operation deadline even when target discovery ignores cancellation", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const pending = new PageBrowser({ fetchImpl, loadTimeoutMs: 20 }).read(500);
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5020);
    await rejected;
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
