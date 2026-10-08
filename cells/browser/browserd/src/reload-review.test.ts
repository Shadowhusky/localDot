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

describe("independent owned reload completion", () => {
  it("a newer root navigation cannot reuse an earlier completed load", async () => {
    const f = await started();
    let state = "pending";
    const reload = f.targets.reload(f.tabId).then(
      () => {
        state = "resolved";
      },
      () => {
        state = "rejected";
      },
    );
    try {
      await settle();
      f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "loader-a" } }, "session-1");
      f.event("Page.loadEventFired", { timestamp: 1 }, "session-1");
      f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "loader-b" } }, "session-1");
      await settle();
      expect(state).not.toBe("resolved");
      f.event("Page.loadEventFired", { timestamp: 2 }, "session-1");
    } finally {
      f.targets.close();
      await reload;
    }
  });
  it("the declared reload deadline also bounds a missing command acknowledgement", async () => {
    vi.useFakeTimers();
    const f = await started();
    f.intercept((command) => command.method === "Page.reload");
    let state = "pending";
    const reload = f.targets.reload(f.tabId).then(
      () => {
        state = "resolved";
      },
      () => {
        state = "rejected";
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(BROWSER_RELOAD_TIMEOUT_MS + 1);
      expect(state).toBe("rejected");
    } finally {
      f.targets.close();
      await reload;
    }
  });
  it("P3 one current root navigation and load completes without exposing raw target metadata", async () => {
    const f = await started();
    const reload = f.targets.reload(f.tabId);
    try {
      await settle();
      f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "loader-a" } }, "session-1");
      f.event("Page.loadEventFired", { timestamp: 1 }, "session-1");
      await expect(reload).resolves.toBeUndefined();
      expect(f.targets.closed).toBe(false);
      expect(JSON.stringify(f.targets.tabs())).not.toContain("canary");
    } finally {
      f.targets.close();
    }
  });
});
