import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpTransport } from "./pipe.ts";
import {
  BROWSER_TARGET_START_TIMEOUT_MS,
  type BrowserDocument,
  BrowserTargets,
} from "./targets.ts";

interface Command {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}
const info = (id: string, type: "page" | "iframe" = "page") => ({
  targetId: id,
  type,
  title: "fixture-private-title",
  url: "https://example.test/private",
  attached: false,
});
function setup() {
  let receive = (_text: string) => {},
    onInvalidated = () => {};
  let intercept: ((command: Command) => boolean) | undefined;
  const writes: Command[] = [],
    fatal = vi.fn(),
    closed = vi.fn();
  const event = (method: string, params: unknown, sessionId?: string) =>
    receive(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  const reply = (c: Command, result: unknown = {}) =>
    receive(
      JSON.stringify({ id: c.id, ...(c.sessionId ? { sessionId: c.sessionId } : {}), result }),
    );
  const attach = (
    id = "page",
    sessionId = "session",
    parent?: string,
    type: "page" | "iframe" = "page",
  ) =>
    event(
      "Target.attachedToTarget",
      { sessionId, targetInfo: info(id, type), waitingForDebugger: true },
      parent,
    );
  const transport: CdpTransport = {
    write(text) {
      const c = JSON.parse(text) as Command;
      writes.push(c);
      if (intercept?.(c)) return;
      queueMicrotask(() => {
        if (c.method === "Target.setDiscoverTargets")
          event("Target.targetCreated", { targetInfo: info("page") });
        if (c.method === "Target.setAutoAttach" && !c.sessionId) attach();
        reply(
          c,
          c.method === "Browser.getWindowForTarget"
            ? {
                windowId: 7,
                bounds: { left: 0, top: 0, width: 1000, height: 700, windowState: "normal" },
              }
            : {},
        );
      });
    },
    close: closed,
    onMessage(listener) {
      receive = listener;
      return () => {};
    },
    onClose: () => () => {},
  };
  const targets = new BrowserTargets(transport, {
    downloadDir: "/tmp/private-downloads",
    uploadDir: "/tmp/private-uploads",
    onFatal: fatal,
    onInvalidated: () => onInvalidated(),
  });
  return {
    targets,
    writes,
    fatal,
    closed,
    event,
    reply,
    attach,
    invalidationHook: (fn: () => void) => {
      onInvalidated = fn;
    },
    intercept: (fn: (command: Command) => boolean) => {
      intercept = fn;
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
async function started() {
  const f = setup();
  await f.targets.start();
  const tab = f.targets.tabs()[0];
  if (!tab) throw new Error("missing fixture tab");
  const document = f.targets.documents(tab.id)[0];
  if (!document) throw new Error("missing fixture document");
  return { ...f, tabId: tab.id, document };
}
const result = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: Error) => e.message,
  );
afterEach(() => vi.useRealTimers());

describe("independent BrowserTargets boundary review", () => {
  it("P1 current document permits one granted-node operation after protection setup", async () => {
    const f = await started();
    try {
      f.targets.rememberNodes(f.document, [41]);
      const before = f.writes.length;
      await expect(
        f.targets.command(f.document, "DOM.describeNode", { backendNodeId: 41 }),
      ).resolves.toEqual({});
      expect(f.writes.slice(before)).toEqual([
        expect.objectContaining({ method: "DOM.describeNode", sessionId: "session" }),
      ]);
      const methods = f.writes.filter((c) => c.sessionId === "session").map((c) => c.method);
      expect(methods.indexOf("Runtime.runIfWaitingForDebugger")).toBeGreaterThan(
        methods.indexOf("Page.setInterceptFileChooserDialog"),
      );
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      f.targets.close();
    }
  });

  it("P2 ordinary navigation allows a new document while refusing the old identity", async () => {
    const f = await started();
    try {
      f.event(
        "Page.navigatedWithinDocument",
        { frameId: "frame", url: "https://example.test/next" },
        "session",
      );
      const next = f.targets.documents(f.tabId)[0] as BrowserDocument;
      expect(() => f.targets.check(f.document)).toThrow("stale");
      await expect(f.targets.command(next, "Page.enable")).resolves.toEqual({});
      expect(next.revision).toBeGreaterThan(f.document.revision);
    } finally {
      f.targets.close();
    }
  });

  it("an unassigned iframe fences commands through an already retained document", async () => {
    const f = await started();
    f.targets.rememberNodes(f.document, [41]);
    f.event("Target.targetCreated", { targetInfo: info("unknown-child", "iframe") });
    expect(() => f.targets.documents(f.tabId)).toThrow("unready");
    const before = f.writes.length;
    const pending = result(
      f.targets.command(f.document, "DOM.describeNode", { backendNodeId: 41 }),
    );
    try {
      expect(f.writes.slice(before)).toHaveLength(0);
      await expect(pending).resolves.not.toBe("resolved");
    } finally {
      f.targets.close();
      await pending;
    }
  });

  it("a retiring target cannot mint a replacement document inside invalidation publication", async () => {
    const f = await started();
    const outcomes: Promise<string>[] = [];
    f.invalidationHook(() => {
      try {
        const next = f.targets.documents(f.tabId)[0] as BrowserDocument;
        outcomes.push(
          result(
            f.targets.command(next, "Page.navigate", {
              url: "https://example.test/should-not-write",
            }),
          ),
        );
      } catch {
        /* Revocation before publication is the expected path. */
      }
    });
    const before = f.writes.length;
    try {
      f.event("Target.targetDestroyed", { targetId: "page" });
      expect(f.writes.slice(before)).toHaveLength(0);
      expect(f.targets.tabs()).toEqual([]);
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      f.targets.close();
      await Promise.all(outcomes);
    }
  });

  it("old target and session strings cannot revive an identity-bound document", async () => {
    const f = await started();
    try {
      f.event("Target.targetDestroyed", { targetId: "page" });
      f.attach();
      await settle();
      const before = f.writes.length;
      await expect(f.targets.command(f.document, "Page.enable")).rejects.toThrow("stale");
      expect(f.writes).toHaveLength(before);
      const tab = f.targets.tabs()[0];
      expect(tab?.id).not.toBe(f.tabId);
      const next = f.targets.documents(tab?.id ?? "missing")[0] as BrowserDocument;
      await expect(f.targets.command(next, "Page.enable")).resolves.toEqual({});
    } finally {
      f.targets.close();
    }
  });

  it("a revoked window owner cannot publish geometry or authorize a maximize write", async () => {
    const f = await started();
    let held: Command | undefined;
    f.intercept((c) => {
      if (c.method === "Browser.getWindowForTarget") {
        held = c;
        return true;
      }
      return false;
    });
    const pending = result(f.targets.maximize(f.tabId));
    try {
      expect(held).toBeDefined();
      f.event("Target.targetDestroyed", { targetId: "page" });
      if (!held) throw new Error("missing held geometry");
      f.reply(held, {
        windowId: 7,
        bounds: { left: 0, top: 0, width: 1000, height: 700, windowState: "normal" },
      });
      await expect(pending).resolves.toContain("stale");
      expect(f.writes.filter((c) => c.method === "Browser.setWindowBounds")).toHaveLength(0);
    } finally {
      f.targets.close();
      await pending;
    }
  });

  it("an old node result is discarded after document replacement", async () => {
    const f = await started();
    f.targets.rememberNodes(f.document, [41]);
    let held: Command | undefined;
    f.intercept((c) => {
      if (c.method === "DOM.describeNode") {
        held = c;
        return true;
      }
      return false;
    });
    const pending = result(
      f.targets.command(f.document, "DOM.describeNode", { backendNodeId: 41 }),
    );
    try {
      f.event("DOM.documentUpdated", {}, "session");
      if (!held) throw new Error("missing held node read");
      f.reply(held, { privateData: "old-document" });
      await expect(pending).resolves.toBe("Browser target refused: stale");
      const current = f.targets.documents(f.tabId)[0] as BrowserDocument;
      const before = f.writes.length;
      await expect(
        f.targets.command(current, "DOM.describeNode", { backendNodeId: 41 }),
      ).rejects.toThrow("scope");
      expect(f.writes).toHaveLength(before);
    } finally {
      f.targets.close();
      await pending;
    }
  });

  it("successful slow commands cannot extend startup beyond the registry deadline", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.intercept((c) => {
      setTimeout(() => {
        if (c.method === "Target.setDiscoverTargets")
          f.event("Target.targetCreated", { targetInfo: info("page") });
        if (c.method === "Target.setAutoAttach" && !c.sessionId) f.attach();
        f.reply(c);
      }, 4900);
      return true;
    });
    const pending = result(f.targets.start());
    try {
      await vi.advanceTimersByTimeAsync(BROWSER_TARGET_START_TIMEOUT_MS);
      await expect(pending).resolves.toBe("Browser target refused: unready");
      expect(f.targets.closed).toBe(true);
      expect(f.fatal).toHaveBeenCalledTimes(1);
    } finally {
      f.targets.close();
      vi.clearAllTimers();
      await pending;
    }
  });
});
