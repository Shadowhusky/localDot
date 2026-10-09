import { afterEach, describe, expect, it, vi } from "vitest";
import { CDP_REQUEST_TIMEOUT_MS, GuardedCdp, MAX_CDP_PENDING } from "./cdp.ts";

function setup() {
  let receive = (_message: string) => {};
  let disconnected = () => {};
  const write = vi.fn();
  const close = vi.fn();
  const fatal = vi.fn();
  const broker = new GuardedCdp(
    {
      write,
      close,
      onMessage: (listener) => {
        receive = listener;
        return () => {};
      },
      onClose: (listener) => {
        disconnected = listener;
        return () => {};
      },
    },
    {
      downloadDir: "/tmp/downloads",
      uploadDir: "/tmp/uploads",
      ownsTarget: () => false,
      ownsSession: (session) => session === "owned",
      ownsWindow: () => false,
      ownsNode: () => false,
      ownsDownload: () => false,
      allowsUpload: () => false,
    },
    fatal,
  );
  return {
    broker,
    write,
    close,
    fatal,
    receive: (message: unknown) => receive(JSON.stringify(message)),
    raw: (message: string) => receive(message),
    disconnected: () => disconnected(),
  };
}

afterEach(() => vi.useRealTimers());

describe("guarded Chromium request broker", () => {
  it("refuses forbidden calls before any transport write", async () => {
    const { broker, write } = setup();
    await expect(
      broker.send("Runtime.evaluate", { expression: "document.cookie" }),
    ).rejects.toThrow("method");
    await expect(
      broker.send("Page.reload", { scriptToEvaluateOnLoad: "secret" }, { sessionId: "owned" }),
    ).rejects.toThrow("params");
    expect(write).not.toHaveBeenCalled();
    broker.close();
  });

  it("matches root and flattened page replies to the original requests", async () => {
    const { broker, write, receive, fatal } = setup();
    const root = broker.send("Browser.getVersion");
    const page = broker.send("Page.getFrameTree", {}, { sessionId: "owned" });
    expect(write.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      { id: 1, method: "Browser.getVersion", params: {} },
      { id: 2, method: "Page.getFrameTree", params: {}, sessionId: "owned" },
    ]);
    receive({ id: 2, sessionId: "owned", result: { frameTree: {} } });
    receive({ id: 1, result: { product: "Chromium" } });
    await expect(root).resolves.toEqual({ product: "Chromium" });
    await expect(page).resolves.toEqual({ frameTree: {} });
    expect(fatal).not.toHaveBeenCalled();
    broker.close();
  });

  it.each([
    { id: 1, sessionId: "foreign", result: {} },
    { id: 1, result: {}, error: {} },
    { id: 1 },
    { id: 1, result: [] },
    { id: 1, result: {}, expression: "secret" },
    { id: "1", result: {} },
    { id: 1, error: {} },
    { id: 1, error: { code: "-1", message: "private" } },
  ])("fences on malformed or mismatched replies %#", async (response) => {
    const { broker, receive, close, fatal } = setup();
    const pending = broker.send("Browser.getVersion");
    receive(response);
    await expect(pending).rejects.toThrow("protocol");
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(broker.closed).toBe(true);
  });

  it("does not reflect CDP error details into the caller", async () => {
    const { broker, receive } = setup();
    const pending = broker.send("Browser.getVersion");
    receive({ id: 1, error: { code: -1, message: "private cookie canary", data: "secret" } });
    await expect(pending).rejects.toThrow(/^Browser request refused: failed$/u);
    expect(broker.closed).toBe(false);
    broker.close();
  });

  it("fences every pending command after an uncertain timeout", async () => {
    vi.useFakeTimers();
    const { broker, receive, fatal, close } = setup();
    const first = expect(broker.send("Browser.getVersion")).rejects.toThrow("timeout");
    const second = expect(broker.send("Page.enable", {}, { sessionId: "owned" })).rejects.toThrow(
      "timeout",
    );
    await vi.advanceTimersByTimeAsync(CDP_REQUEST_TIMEOUT_MS);
    await Promise.all([first, second]);
    receive({ id: 1, result: { private: "late" } });
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(broker.send("Browser.getVersion")).rejects.toThrow("closed");
  });

  it("a cancelled written command fences the connection, while pre-cancelled work writes nothing", async () => {
    const { broker, write, close } = setup();
    const aborted = new AbortController();
    aborted.abort();
    await expect(broker.send("Browser.getVersion", {}, { signal: aborted.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(write).not.toHaveBeenCalled();
    expect(broker.closed).toBe(false);
    const live = new AbortController();
    const pending = broker.send("Browser.getVersion", {}, { signal: live.signal });
    live.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(close).toHaveBeenCalledTimes(1);
    expect(broker.closed).toBe(true);
  });

  // A slow page answers reads slowly; one given up on changed nothing in Chromium.
  it.each([
    ["cancelled", "DOMSnapshot.captureSnapshot", { computedStyles: [] }],
    ["timeout", "DOMSnapshot.captureSnapshot", { computedStyles: [] }],
    ["cancelled", "DOM.getNodeForLocation", { x: 10, y: 20 }],
  ] as const)(
    "drops a %s page read (%s) and its late reply without fencing the connection",
    async (outcome, method, params) => {
      vi.useFakeTimers();
      const { broker, receive, fatal, close } = setup();
      const live = new AbortController();
      const read = broker.send(method, params, { sessionId: "owned", signal: live.signal });
      const refused = expect(read).rejects.toThrow(outcome);
      if (outcome === "cancelled") live.abort();
      else await vi.advanceTimersByTimeAsync(CDP_REQUEST_TIMEOUT_MS);
      await refused;
      receive({ id: 1, sessionId: "owned", result: { documents: [], strings: [] } });
      const next = broker.send("Page.getFrameTree", {}, { sessionId: "owned" });
      receive({ id: 2, sessionId: "owned", result: { frameTree: {} } });
      await expect(next).resolves.toEqual({ frameTree: {} });
      expect(fatal).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      broker.close();
    },
  );

  it("bounds pending requests and recovers capacity after a legitimate response", async () => {
    const { broker, write, receive } = setup();
    const pending = Array.from({ length: MAX_CDP_PENDING }, () =>
      broker.send("Browser.getVersion"),
    );
    await expect(broker.send("Browser.getVersion")).rejects.toThrow("busy");
    expect(write).toHaveBeenCalledTimes(MAX_CDP_PENDING);
    receive({ id: 1, result: {} });
    await pending[0];
    pending.push(broker.send("Browser.getVersion"));
    for (let id = 2; id <= MAX_CDP_PENDING + 1; id += 1) receive({ id, result: {} });
    await Promise.all(pending);
    broker.close();
  });

  it("propagates a transport disconnect and ignores late messages", async () => {
    const { broker, disconnected, receive, fatal } = setup();
    const pending = broker.send("Browser.getVersion");
    disconnected();
    await expect(pending).rejects.toThrow("closed");
    receive({ id: 1, result: { private: "late" } });
    broker.close();
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it("drops unregistered events and delivers only admitted owned-session events", () => {
    const { broker, receive } = setup();
    const listener = vi.fn();
    const remove = broker.on("Page.loadEventFired", listener);
    expect(() => broker.on("Network.responseReceived", listener)).toThrow("protocol");
    receive({ method: "Network.responseReceived", params: { cookie: "private" } });
    receive({ method: "Page.loadEventFired", sessionId: "owned", params: { timestamp: 1 } });
    expect(listener).toHaveBeenCalledTimes(1);
    remove();
    receive({ method: "Page.loadEventFired", sessionId: "owned", params: { timestamp: 2 } });
    expect(listener).toHaveBeenCalledTimes(1);
    broker.close();
  });

  it("closes before delivering foreign-session events or malformed JSON", async () => {
    for (const failure of ["event", "json"] as const) {
      const { broker, receive, raw } = setup();
      const listener = vi.fn();
      broker.on("Page.loadEventFired", listener);
      const pending = broker.send("Browser.getVersion");
      if (failure === "event")
        receive({ method: "Page.loadEventFired", sessionId: "foreign", params: {} });
      else raw("{broken");
      await expect(pending).rejects.toThrow("protocol");
      expect(listener).not.toHaveBeenCalled();
    }
  });

  it.each([
    { method: "Page.loadEventFired", params: {} },
    { method: "Inspector.detached", params: {} },
    { method: "Browser.downloadProgress", params: {}, sessionId: "owned" },
    { method: "Page.loadEventFired", params: {}, sessionId: "owned", extra: "private" },
  ])("refuses an event delivered in the wrong protocol scope %#", async (event) => {
    const { broker, receive } = setup();
    const pending = broker.send("Browser.getVersion");
    receive(event);
    await expect(pending).rejects.toThrow("protocol");
  });
});
