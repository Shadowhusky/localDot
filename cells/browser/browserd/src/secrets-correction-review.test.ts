import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpTransport } from "./pipe.ts";
import { BROWSER_RELOAD_TIMEOUT_MS, BrowserTargets } from "./targets.ts";

interface WireCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

function info(targetId = "page-1", type: "page" | "iframe" = "page") {
  return {
    targetId,
    type,
    title: "private-title-canary",
    url: "https://example.test/?secret=canary",
    attached: false,
  };
}

function setup() {
  let receive = (_message: string) => {};
  let disconnect = () => {};
  let intercept: ((command: WireCommand) => boolean) | undefined;
  const writes: WireCommand[] = [];
  const fatal = vi.fn();
  const invalidated = vi.fn();
  const close = vi.fn();
  const reply = (command: WireCommand, result: unknown = {}) => {
    receive(
      JSON.stringify({
        id: command.id,
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        result,
      }),
    );
  };
  const event = (method: string, params: unknown, sessionId?: string) => {
    receive(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  };
  const attach = (
    targetId = "page-1",
    sessionId = "session-1",
    parentSessionId?: string,
    type: "page" | "iframe" = "page",
  ) => {
    event(
      "Target.attachedToTarget",
      { sessionId, targetInfo: info(targetId, type), waitingForDebugger: true },
      parentSessionId,
    );
  };
  const transport: CdpTransport = {
    write: (message) => {
      const command = JSON.parse(message) as WireCommand;
      writes.push(command);
      if (intercept?.(command)) return;
      queueMicrotask(() => {
        if (command.method === "Target.setDiscoverTargets")
          event("Target.targetCreated", { targetInfo: info() });
        if (command.method === "Target.setAutoAttach" && command.sessionId === undefined) attach();
        reply(
          command,
          command.method === "Browser.getWindowForTarget"
            ? {
                windowId: 7,
                bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: "normal" },
              }
            : {},
        );
      });
    },
    close,
    onMessage: (listener) => {
      receive = listener;
      return () => {};
    },
    onClose: (listener) => {
      disconnect = listener;
      return () => {};
    },
  };
  const targets = new BrowserTargets(transport, {
    downloadDir: "/tmp/downloads",
    uploadDir: "/tmp/uploads",
    onFatal: fatal,
    onInvalidated: invalidated,
  });
  return {
    targets,
    writes,
    reply,
    event,
    attach,
    fatal,
    invalidated,
    close,
    disconnect: () => disconnect(),
    intercept: (handler: (command: WireCommand) => boolean) => {
      intercept = handler;
    },
  };
}

async function settle() {
  for (let step = 0; step < 40; step += 1) await Promise.resolve();
}

async function started() {
  const fixture = setup();
  await fixture.targets.start();
  const tab = fixture.targets.tabs()[0];
  if (!tab) throw new Error("missing fixture tab");
  const document = fixture.targets.documents(tab.id)[0];
  if (!document) throw new Error("missing fixture document");
  return { ...fixture, tabId: tab.id, document };
}

afterEach(() => vi.useRealTimers());

describe("scoped reload correction boundaries", () => {
  it("C1 repeated navigation after acknowledged load refuses persistently but releases a healthy slot", async () => {
    vi.useFakeTimers();
    const f = await started();
    try {
      const refused = expect(f.targets.reload(f.tabId)).rejects.toThrow("stale");
      await settle();
      f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "first" } }, "session-1");
      f.event("Page.loadEventFired", { timestamp: 1 }, "session-1");
      f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "second" } }, "session-1");
      await refused;
      expect(f.targets.closed).toBe(false);
      expect(f.fatal).not.toHaveBeenCalled();
      const retry = f.targets.reload(f.tabId);
      await settle();
      f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "third" } }, "session-1");
      f.event("Page.loadEventFired", { timestamp: 2 }, "session-1");
      await retry;
      await vi.advanceTimersByTimeAsync(BROWSER_RELOAD_TIMEOUT_MS + 1);
      expect(f.targets.closed).toBe(false);
      expect(f.fatal).not.toHaveBeenCalled();
      expect(f.writes.filter((c) => c.method === "Page.reload")).toHaveLength(2);
    } finally {
      f.targets.close();
    }
  });
  it("C2 external cancellation fences an outstanding acknowledgement and late reply cannot revive authority", async () => {
    const f = await started();
    const abort = new AbortController();
    f.intercept((command) => command.method === "Page.reload");
    try {
      const refused = expect(f.targets.reload(f.tabId, abort.signal)).rejects.toThrow();
      const pending = f.writes.find((c) => c.method === "Page.reload");
      if (!pending) throw new Error("missing owned reload");
      abort.abort();
      expect(f.targets.closed).toBe(true);
      expect(f.fatal).toHaveBeenCalledTimes(1);
      await refused;
      f.reply(pending);
      await settle();
      expect(() => f.targets.documents(f.tabId)).toThrow("closed");
      await expect(f.targets.reload(f.tabId)).rejects.toThrow("closed");
      expect(f.writes.filter((c) => c.method === "Page.reload")).toHaveLength(1);
      expect(f.fatal).toHaveBeenCalledTimes(1);
    } finally {
      f.targets.close();
    }
  });
  it("C3 cancellation after load but before publication cannot publish successful completion", async () => {
    const f = await started();
    const abort = new AbortController();
    try {
      const refused = expect(f.targets.reload(f.tabId, abort.signal)).rejects.toThrow("stale");
      await settle();
      f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "first" } }, "session-1");
      f.event("Page.loadEventFired", { timestamp: 1 }, "session-1");
      abort.abort();
      await refused;
      expect(f.targets.closed).toBe(false);
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      f.targets.close();
    }
  });
  it("C4 acknowledged-load timeout releases its slot without retiring healthy authority", async () => {
    vi.useFakeTimers();
    const f = await started();
    try {
      const refused = expect(f.targets.reload(f.tabId)).rejects.toThrow("unready");
      await settle();
      await vi.advanceTimersByTimeAsync(BROWSER_RELOAD_TIMEOUT_MS + 1);
      await refused;
      expect(f.targets.closed).toBe(false);
      expect(f.fatal).not.toHaveBeenCalled();
      const retry = f.targets.reload(f.tabId);
      await settle();
      f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "fresh" } }, "session-1");
      f.event("Page.loadEventFired", { timestamp: 2 }, "session-1");
      await retry;
      await vi.advanceTimersByTimeAsync(BROWSER_RELOAD_TIMEOUT_MS + 1);
      expect(f.targets.closed).toBe(false);
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      f.targets.close();
    }
  });
});
