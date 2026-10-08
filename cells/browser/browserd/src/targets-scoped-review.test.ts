import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpTransport } from "./pipe.ts";
import { type BrowserDocument, BrowserTargets } from "./targets.ts";

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

describe("scoped BrowserTargets correction interactions", () => {
  it("a frame removed reentrantly still revokes an older pending read while a new document works", async () => {
    const f = await started();
    let held: Command | undefined;
    f.intercept((c) => {
      if (c.method !== "Accessibility.getFullAXTree") return false;
      held = c;
      return true;
    });
    const pending = result(f.targets.command(f.document, "Accessibility.getFullAXTree"));
    let handled = false;
    let next: BrowserDocument | undefined;
    f.invalidationHook(() => {
      if (handled) return;
      handled = true;
      f.event("Target.targetDestroyed", { targetId: "unknown-frame" });
      next = f.targets.documents(f.tabId)[0];
    });
    try {
      f.event("Target.targetCreated", { targetInfo: info("unknown-frame", "iframe") });
      expect(next).toBeDefined();
      if (!held || !next) throw new Error("missing private fixture reply or new document");
      f.reply(held, { privateData: "old-frame-canary" });
      await expect(pending).resolves.toBe("Browser target refused: stale");
      await expect(f.targets.command(next, "Page.enable")).resolves.toEqual({});
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      f.targets.close();
      await pending;
    }
  });

  it("reentrant replacement initializes a new owner while the retired handle stays unusable", async () => {
    const f = await started();
    f.targets.rememberNodes(f.document, [41]);
    let handled = false;
    f.invalidationHook(() => {
      if (handled) return;
      handled = true;
      f.attach();
    });
    try {
      const before = f.writes.length;
      f.event("Target.targetDestroyed", { targetId: "page" });
      await settle();
      expect(f.targets.closed).toBe(false);
      const tab = f.targets.tabs()[0];
      expect(tab?.id).not.toBe(f.tabId);
      expect(tab?.ready).toBe(true);
      expect(f.writes.slice(before).map((c) => c.method)).toEqual([
        "Target.setAutoAttach",
        "Page.enable",
        "DOM.enable",
        "Accessibility.enable",
        "Page.setInterceptFileChooserDialog",
        "Runtime.runIfWaitingForDebugger",
      ]);
      const next = f.targets.documents(tab?.id ?? "missing")[0] as BrowserDocument;
      const admitted = f.writes.length;
      await expect(f.targets.command(f.document, "Page.enable")).rejects.toThrow("stale");
      await expect(
        f.targets.command(next, "DOM.describeNode", { backendNodeId: 41 }),
      ).rejects.toThrow("scope");
      expect(f.writes).toHaveLength(admitted);
      await expect(f.targets.command(next, "Page.enable")).resolves.toEqual({});
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      f.targets.close();
    }
  });

  it("retired queue churn preserves live capacity and only the remaining target initializes", async () => {
    const f = await started();
    const held: Command[] = [];
    f.intercept((c) => {
      if (c.method !== "Target.setAutoAttach" || !c.sessionId?.startsWith("hold-")) return false;
      held.push(c);
      return true;
    });
    try {
      for (let i = 0; i < 4; i++) f.attach(`busy-${i}`, `hold-${i}`);
      expect(held).toHaveLength(4);
      for (let i = 0; i < 280; i++) {
        f.attach(`retired-${i}`, `retired-session-${i}`);
        f.event("Target.targetDestroyed", { targetId: `retired-${i}` });
      }
      expect(f.targets.closed).toBe(false);
      expect(f.targets.tabs()).toHaveLength(5);
      f.attach("remaining", "remaining-session");
      expect(f.writes.filter((c) => c.sessionId === "remaining-session")).toHaveLength(0);
      const first = held[0];
      if (!first) throw new Error("missing private worker");
      f.reply(first);
      await settle();
      expect(f.writes.filter((c) => c.sessionId?.startsWith("retired-session-"))).toHaveLength(0);
      expect(
        f.writes.filter((c) => c.sessionId === "remaining-session").map((c) => c.method),
      ).toEqual([
        "Target.setAutoAttach",
        "Page.enable",
        "DOM.enable",
        "Accessibility.enable",
        "Page.setInterceptFileChooserDialog",
        "Runtime.runIfWaitingForDebugger",
      ]);
      const ready = f.targets.tabs().filter((tab) => tab.ready);
      expect(ready).toHaveLength(3);
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      f.targets.close();
      await settle();
    }
  });
});
