import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpTransport } from "./pipe.ts";
import {
  BROWSER_RELOAD_TIMEOUT_MS,
  type BrowserDocument,
  BrowserTargets,
  MAX_BROWSER_NODES,
  MAX_BROWSER_TARGETS,
  MAX_DOCUMENT_NODES,
} from "./targets.ts";

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

describe("private browser target ownership", () => {
  it("reads cookie scopes and partitions, never values", async () => {
    const peer = await started();
    const partitionKey = { topLevelSite: "https://news.test", hasCrossSiteAncestor: false };
    peer.intercept((command) => {
      if (command.method !== "Storage.getCookies") return false;
      queueMicrotask(() =>
        peer.reply(command, {
          cookies: [
            { name: "SID", value: "secret-canary", domain: ".google.com", path: "/" },
            {
              name: "chat",
              value: "secret-canary",
              domain: "chat.google.com",
              path: "/",
              partitionKey,
            },
          ],
        }),
      );
      return true;
    });
    const cookies = await peer.targets.cookies();
    expect(cookies).toEqual([
      { name: "SID", domain: ".google.com", path: "/" },
      { name: "chat", domain: "chat.google.com", path: "/", partitionKey },
    ]);
    expect(JSON.stringify(cookies)).not.toContain("secret-canary");
  });

  it("reload waits beyond acknowledgement and subframe events for the root load", async () => {
    const peer = await started();
    let completed = false;
    const pending = peer.targets.reload(peer.tabId).then(() => {
      completed = true;
    });
    await settle();
    expect(completed).toBe(false);
    peer.event("Page.loadEventFired", { timestamp: 1 }, "session-1");
    peer.event("Page.frameNavigated", { frame: { id: "child", parentId: "root" } }, "session-1");
    peer.event("Page.loadEventFired", { timestamp: 2 }, "session-1");
    await settle();
    expect(completed).toBe(false);
    peer.event("Page.frameNavigated", { frame: { id: "root" } }, "session-1");
    peer.event("Page.loadEventFired", { timestamp: 3 }, "session-1");
    await pending;
    expect(completed).toBe(true);
    peer.targets.close();
  });

  it("reload refuses already-aborted work and concurrent duplicate reloads", async () => {
    const peer = await started();
    const abort = new AbortController();
    abort.abort();
    await expect(peer.targets.reload(peer.tabId, abort.signal)).rejects.toThrow("stale");
    expect(peer.writes.some((command) => command.method === "Page.reload")).toBe(false);
    const pending = peer.targets.reload(peer.tabId);
    const rejected = expect(pending).rejects.toThrow();
    await expect(peer.targets.reload(peer.tabId)).rejects.toThrow("busy");
    expect(peer.writes.filter((command) => command.method === "Page.reload")).toHaveLength(1);
    peer.targets.close();
    await rejected;
  });

  it("cancellation while waiting for load rejects and releases the navigation slot", async () => {
    const peer = await started();
    const abort = new AbortController();
    const pending = expect(peer.targets.reload(peer.tabId, abort.signal)).rejects.toThrow("stale");
    await settle();
    abort.abort();
    await pending;
    const retry = peer.targets.reload(peer.tabId);
    await settle();
    peer.event("Page.frameNavigated", { frame: { id: "root" } }, "session-1");
    peer.event("Page.loadEventFired", { timestamp: 3 }, "session-1");
    await retry;
    peer.targets.close();
  });

  it("reload times out without treating an acknowledgement as a loaded page", async () => {
    vi.useFakeTimers();
    const peer = await started();
    const pending = expect(peer.targets.reload(peer.tabId)).rejects.toThrow("unready");
    await vi.advanceTimersByTimeAsync(BROWSER_RELOAD_TIMEOUT_MS + 1);
    await pending;
    peer.targets.close();
  });

  it("the reload deadline retires an outstanding acknowledgement and its authority", async () => {
    vi.useFakeTimers();
    const peer = await started();
    peer.intercept((command) => command.method === "Page.reload");
    const rejected = expect(peer.targets.reload(peer.tabId)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(BROWSER_RELOAD_TIMEOUT_MS + 1);
    await rejected;
    expect(peer.targets.closed).toBe(true);
    expect(peer.fatal).toHaveBeenCalledTimes(1);
    expect(() => peer.targets.documents(peer.tabId)).toThrow("closed");
    peer.targets.close();
  });

  it.each([false, true])(
    "a second root navigation revokes a held acknowledgement after prior load=%s",
    async (priorLoad) => {
      const peer = await started();
      peer.intercept((command) => command.method === "Page.reload");
      const rejected = expect(peer.targets.reload(peer.tabId)).rejects.toThrow();
      peer.event("Page.frameNavigated", { frame: { id: "root", loaderId: "first" } }, "session-1");
      if (priorLoad) peer.event("Page.loadEventFired", { timestamp: 1 }, "session-1");
      peer.event("Page.frameNavigated", { frame: { id: "root", loaderId: "second" } }, "session-1");
      await rejected;
      expect(peer.targets.closed).toBe(true);
      expect(peer.fatal).toHaveBeenCalledTimes(1);
      peer.targets.close();
    },
  );

  it.each(["destroy", "close"])("reload releases its wait on %s", async (mode) => {
    const peer = await started();
    const pending = expect(peer.targets.reload(peer.tabId)).rejects.toThrow("stale");
    await settle();
    if (mode === "destroy") peer.event("Target.targetDestroyed", { targetId: "page-1" });
    else peer.targets.close();
    await pending;
    peer.targets.close();
  });

  it("installs protections before resuming and publishes only safe opaque tab IDs", async () => {
    const fixture = await started();
    expect(fixture.targets.tabs()).toEqual([{ id: fixture.tabId, ready: true }]);
    expect(fixture.tabId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(JSON.stringify(fixture.targets.tabs())).not.toMatch(/canary|page-1|session-1/u);
    expect(Object.isFrozen(fixture.targets.tabs())).toBe(true);
    expect(Object.isFrozen(fixture.document)).toBe(true);
    expect(
      fixture.writes
        .filter((command) => command.sessionId === "session-1")
        .map((command) => command.method),
    ).toEqual([
      "Target.setAutoAttach",
      "Page.enable",
      "DOM.enable",
      "Accessibility.enable",
      "Page.setInterceptFileChooserDialog",
      "Runtime.runIfWaitingForDebugger",
    ]);
    const writes = fixture.writes.length;
    await fixture.targets.start();
    expect(fixture.writes).toHaveLength(writes);
    fixture.targets.close();
  });

  it("refuses guessed tab IDs and forged documents without sending commands", async () => {
    const fixture = await started();
    const writes = fixture.writes.length;
    expect(() => fixture.targets.documents("page-1")).toThrow("stale");
    const forged = { ...fixture.document };
    await expect(fixture.targets.command(forged, "Page.enable")).rejects.toThrow("stale");
    expect(() => fixture.targets.rememberNodes(forged, [1])).toThrow("stale");
    expect(fixture.writes).toHaveLength(writes);
    fixture.targets.close();
  });

  it("accepts a current owned document and only its validated node grants", async () => {
    const fixture = await started();
    await expect(
      fixture.targets.command(fixture.document, "DOM.describeNode", { backendNodeId: 41 }),
    ).rejects.toThrow("scope");
    fixture.targets.rememberNodes(fixture.document, [41]);
    await expect(
      fixture.targets.command(fixture.document, "DOM.describeNode", { backendNodeId: 41 }),
    ).resolves.toEqual({});
    expect(fixture.writes.at(-1)?.sessionId).toBe("session-1");
    await expect(
      fixture.targets.command(fixture.document, "Runtime.evaluate", {
        expression: "document.cookie",
      }),
    ).rejects.toThrow("method");
    await expect(
      fixture.targets.command(fixture.document, "DOM.setFileInputFiles", {
        backendNodeId: 41,
        files: ["/tmp/uploads/receipt"],
      }),
    ).rejects.toThrow("upload");
    fixture.targets.close();
  });

  it.each([
    ["DOM.documentUpdated", {}],
    ["Page.frameAttached", { frameId: "frame-1", parentFrameId: "root-frame" }],
    ["Page.frameDetached", { frameId: "frame-1", reason: "swap" }],
    ["Page.frameNavigated", { frame: { id: "frame-1", url: "private-canary" } }],
    ["Page.navigatedWithinDocument", { frameId: "frame-1", url: "https://example.test/#next" }],
  ])("revokes documents and nodes synchronously on %s", async (method, params) => {
    const fixture = await started();
    fixture.targets.rememberNodes(fixture.document, [41]);
    fixture.event(method, params, "session-1");
    expect(() => fixture.targets.check(fixture.document)).toThrow("stale");
    const next = fixture.targets.documents(fixture.tabId)[0] as BrowserDocument;
    expect(next.revision).toBeGreaterThan(fixture.document.revision);
    await expect(
      fixture.targets.command(next, "DOM.describeNode", { backendNodeId: 41 }),
    ).rejects.toThrow("scope");
    await expect(fixture.targets.command(next, "Page.enable")).resolves.toEqual({});
    expect(fixture.invalidated).toHaveBeenCalledTimes(1);
    fixture.targets.close();
  });

  it("discards a result when navigation races a private page read", async () => {
    const fixture = await started();
    let held: WireCommand | undefined;
    fixture.intercept((command) => {
      held = command;
      return true;
    });
    const pending = fixture.targets.command(fixture.document, "Accessibility.getFullAXTree");
    fixture.event("DOM.documentUpdated", {}, "session-1");
    if (!held) throw new Error("expected pending request");
    fixture.reply(held, { nodes: [{ value: "private-stale-canary" }] });
    await expect(pending).rejects.toThrow(/^Browser target refused: stale$/u);
    expect(fixture.fatal).not.toHaveBeenCalled();
    fixture.targets.close();
  });

  it("recursively initializes frames and invalidates ancestors before exposing a new child", async () => {
    const fixture = await started();
    fixture.attach("frame-1", "frame-session", "session-1", "iframe");
    expect(() => fixture.targets.check(fixture.document)).toThrow("stale");
    expect(() => fixture.targets.documents(fixture.tabId)).toThrow("unready");
    await settle();
    const documents = fixture.targets.documents(fixture.tabId);
    expect(documents).toHaveLength(2);
    expect(documents.map((document) => document.frame)).toEqual([false, true]);
    const root = documents[0] as BrowserDocument;
    const frame = documents[1] as BrowserDocument;
    fixture.event(
      "Target.targetInfoChanged",
      { targetInfo: info("frame-1", "iframe") },
      "session-1",
    );
    expect(fixture.targets.closed).toBe(false);
    fixture.targets.rememberNodes(root, [41]);
    await expect(
      fixture.targets.command(frame, "DOM.describeNode", { backendNodeId: 41 }),
    ).rejects.toThrow("scope");
    fixture.targets.rememberNodes(frame, [42]);
    await expect(
      fixture.targets.command(frame, "DOM.describeNode", { backendNodeId: 42 }),
    ).resolves.toEqual({});
    fixture.event("DOM.documentUpdated", {}, "frame-session");
    expect(() => fixture.targets.check(root)).toThrow("stale");
    expect(() => fixture.targets.check(frame)).toThrow("stale");
    fixture.targets.close();
  });

  it("revokes in-flight results and node grants across a transient unassigned frame", async () => {
    const fixture = await started();
    fixture.targets.rememberNodes(fixture.document, [41]);
    let held: WireCommand | undefined;
    fixture.intercept((command) => {
      if (command.method !== "Accessibility.getFullAXTree") return false;
      held = command;
      return true;
    });
    const pending = fixture.targets.command(fixture.document, "Accessibility.getFullAXTree");
    fixture.event("Target.targetCreated", { targetInfo: info("transient-frame", "iframe") });
    fixture.event("Target.targetDestroyed", { targetId: "transient-frame" });
    if (!held) throw new Error("expected pending request");
    fixture.reply(held, { nodes: [{ value: "private-stale-canary" }] });
    await expect(pending).rejects.toThrow("stale");
    const current = fixture.targets.documents(fixture.tabId)[0] as BrowserDocument;
    await expect(
      fixture.targets.command(current, "DOM.describeNode", { backendNodeId: 41 }),
    ).rejects.toThrow("scope");
    await expect(fixture.targets.command(current, "Page.enable")).resolves.toEqual({});
    expect(fixture.fatal).not.toHaveBeenCalled();
    fixture.targets.close();
  });

  it("publishes unknown-frame invalidation only after fencing fresh and retained documents", async () => {
    const fixture = await started();
    const observations: string[] = [];
    fixture.invalidated.mockImplementation(() => {
      for (const read of [
        () => fixture.targets.documents(fixture.tabId),
        () => fixture.targets.check(fixture.document),
      ]) {
        try {
          read();
          observations.push("admitted");
        } catch (error) {
          observations.push((error as Error).message);
        }
      }
    });
    fixture.event("Target.targetCreated", { targetInfo: info("unknown-frame", "iframe") });
    expect(observations).toEqual([
      "Browser target refused: unready",
      "Browser target refused: stale",
    ]);
    expect(fixture.fatal).not.toHaveBeenCalled();
    fixture.targets.close();
  });

  it.each(["close", "remove-parent", "remove-child"])(
    "does not initialize a frame after a discovery observer requests %s",
    async (action) => {
      const fixture = await started();
      fixture.invalidated.mockImplementationOnce(() => {
        if (action === "close") fixture.targets.close();
        else
          fixture.event("Target.targetDestroyed", {
            targetId: action === "remove-parent" ? "page-1" : "reentrant-frame",
          });
      });
      const before = fixture.writes.length;
      fixture.attach("reentrant-frame", "reentrant-session", "session-1", "iframe");
      await settle();
      expect(fixture.writes.slice(before)).toEqual([]);
      if (action === "close") expect(fixture.targets.closed).toBe(true);
      else {
        expect(fixture.fatal).not.toHaveBeenCalled();
        if (action === "remove-parent") expect(fixture.targets.tabs()).toEqual([]);
        else expect(fixture.targets.documents(fixture.tabId)).toHaveLength(1);
      }
      fixture.targets.close();
    },
  );

  it("does not queue a popup retired during its attachment notification", async () => {
    const fixture = await started();
    fixture.invalidated.mockImplementationOnce(() => {
      fixture.event("Target.targetDestroyed", { targetId: "popup" });
    });
    const before = fixture.writes.length;
    fixture.attach("popup", "popup-session", "session-1");
    await settle();
    expect(fixture.writes.slice(before)).toEqual([]);
    expect(fixture.targets.tabs()).toEqual([{ id: fixture.tabId, ready: true }]);
    expect(fixture.targets.documents(fixture.tabId)).toHaveLength(1);
    expect(fixture.fatal).not.toHaveBeenCalled();
    fixture.targets.close();
  });

  it("fences document access while a discovered frame has unknown attachment ownership", async () => {
    const fixture = await started();
    fixture.event("Target.targetCreated", { targetInfo: info("frame-new", "iframe") });
    expect(() => fixture.targets.documents(fixture.tabId)).toThrow("unready");
    fixture.attach("frame-new", "frame-new-session", "session-1", "iframe");
    await settle();
    expect(fixture.targets.documents(fixture.tabId)).toHaveLength(2);
    fixture.targets.close();
  });

  it("revokes a detached child and ancestor snapshots while keeping its parent usable", async () => {
    const fixture = await started();
    fixture.attach("frame-1", "frame-session", "session-1", "iframe");
    await settle();
    const documents = fixture.targets.documents(fixture.tabId);
    fixture.event(
      "Target.detachedFromTarget",
      { sessionId: "frame-session", targetId: "frame-1" },
      "session-1",
    );
    fixture.event("Target.targetInfoChanged", { targetInfo: info("frame-1", "iframe") });
    for (const document of documents)
      expect(() => fixture.targets.check(document)).toThrow("stale");
    expect(fixture.targets.documents(fixture.tabId)).toHaveLength(1);
    expect(fixture.fatal).not.toHaveBeenCalled();
    fixture.targets.close();
  });

  it("recursively removes descendants when their owning page closes", async () => {
    const fixture = await started();
    fixture.attach("frame-1", "frame-session", "session-1", "iframe");
    await settle();
    fixture.attach("nested-1", "nested-session", "frame-session", "iframe");
    await settle();
    const documents = fixture.targets.documents(fixture.tabId);
    expect(documents).toHaveLength(3);
    fixture.event("Target.targetDestroyed", { targetId: "page-1" });
    for (const document of documents)
      expect(() => fixture.targets.check(document)).toThrow("stale");
    expect(fixture.targets.tabs()).toEqual([]);
    fixture.event("Target.detachedFromTarget", { sessionId: "session-1" });
    expect(fixture.fatal).not.toHaveBeenCalled();
    fixture.targets.close();
  });

  it("does not let a reused target or session ID revive an old document", async () => {
    const fixture = await started();
    fixture.event("Target.targetDestroyed", { targetId: "page-1" });
    fixture.attach();
    await settle();
    expect(() => fixture.targets.check(fixture.document)).toThrow("stale");
    expect(fixture.targets.tabs()[0]?.id).not.toBe(fixture.tabId);
    fixture.targets.close();
  });

  it.each([
    [
      "Target.attachedToTarget",
      {
        sessionId: "foreign-child",
        targetInfo: info("frame-1", "iframe"),
        waitingForDebugger: true,
      },
      undefined,
    ],
    [
      "Target.attachedToTarget",
      {
        sessionId: "foreign-child",
        targetInfo: info("frame-1", "iframe"),
        waitingForDebugger: true,
      },
      "not-owned",
    ],
    [
      "Target.attachedToTarget",
      { sessionId: "session-1", targetInfo: info("other-page"), waitingForDebugger: true },
      undefined,
    ],
    [
      "Target.attachedToTarget",
      { sessionId: "new-session", targetInfo: info(), waitingForDebugger: true },
      undefined,
    ],
    ["Target.targetCreated", { targetInfo: { ...info(), type: "service_worker" } }, undefined],
    ["Target.targetCreated", { targetInfo: { ...info(), targetId: "canary\n" } }, undefined],
    [
      "Target.targetCreated",
      { targetInfo: { ...info(), title: "canary".repeat(2000) } },
      undefined,
    ],
    ["Target.targetInfoChanged", { targetInfo: info("page-1", "iframe") }, undefined],
    ["Target.targetInfoChanged", { targetInfo: info() }, "session-1"],
    ["Target.detachedFromTarget", { sessionId: "session-1", targetId: "wrong-target" }, undefined],
    ["Target.detachedFromTarget", { sessionId: "session-1" }, "session-1"],
    ["DOM.documentUpdated", {}, undefined],
    ["Page.frameNavigated", { frame: { id: "bad\n" } }, "session-1"],
  ])(
    "contains malformed/foreign protocol ownership event %#",
    async (method, params, sessionId) => {
      const fixture = await started();
      fixture.event(method, params, sessionId);
      expect(fixture.targets.closed).toBe(true);
      expect(fixture.fatal).toHaveBeenCalledTimes(1);
      expect(fixture.close).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(fixture.fatal.mock.calls)).not.toMatch(/canary|secret|foreign-child/u);
      expect(() => fixture.targets.check(fixture.document)).toThrow("closed");
      fixture.targets.close();
      expect(fixture.fatal).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      "Target.targetCrashed",
      { targetId: "page-1", status: "private-canary", errorCode: 1 },
      undefined,
    ],
    ["Inspector.targetCrashed", {}, "session-1"],
  ])("fences capabilities on %s", async (method, params, sessionId) => {
    const fixture = await started();
    fixture.event(method, params, sessionId);
    expect(fixture.targets.closed).toBe(true);
    expect(fixture.fatal).toHaveBeenCalledTimes(1);
    expect(fixture.fatal.mock.calls[0]?.[0].message).toBe("Browser target refused: closed");
  });

  it("revokes ordinary inspector detachment without closing another healthy tab", async () => {
    const fixture = await started();
    fixture.attach("page-other", "session-other");
    await settle();
    fixture.event("Inspector.detached", { reason: "target_closed" }, "session-1");
    expect(() => fixture.targets.check(fixture.document)).toThrow("stale");
    expect(fixture.targets.tabs()).toHaveLength(1);
    expect(fixture.targets.closed).toBe(false);
    fixture.targets.close();
  });

  it("does not retain private target metadata when the title or URL changes", async () => {
    const fixture = await started();
    fixture.event("Target.targetInfoChanged", {
      targetInfo: {
        ...info(),
        title: "new-private-canary",
        url: "https://example.test/token?secret=other",
      },
    });
    expect(fixture.targets.tabs()).toEqual([{ id: fixture.tabId, ready: true }]);
    expect(JSON.stringify(fixture.document)).not.toMatch(/canary|secret|session/u);
    fixture.targets.close();
  });

  it("bounds target maps and closes before accepting the overflow entry", async () => {
    const fixture = await started();
    for (let index = 1; index < MAX_BROWSER_TARGETS; index += 1) {
      fixture.event("Target.targetCreated", { targetInfo: info(`page-${index + 1}`) });
    }
    expect(fixture.targets.tabs()).toHaveLength(MAX_BROWSER_TARGETS);
    fixture.event("Target.targetCreated", { targetInfo: info("overflow") });
    expect(fixture.targets.closed).toBe(true);
    expect(fixture.fatal).toHaveBeenCalledTimes(1);
  });

  it("bounds initialization to four pending session commands and resumes queued work", async () => {
    const fixture = await started();
    const held: WireCommand[] = [];
    fixture.intercept((command) => {
      if (command.sessionId) {
        held.push(command);
        return true;
      }
      return false;
    });
    for (let index = 0; index < 12; index += 1)
      fixture.attach(`extra-${index}`, `session-extra-${index}`);
    expect(held).toHaveLength(4);
    for (let round = 0; round < 20; round += 1) {
      for (const command of held.splice(0)) fixture.reply(command);
      await settle();
      expect(held.length).toBeLessThanOrEqual(4);
    }
    expect(fixture.targets.tabs().every((tab) => tab.ready)).toBe(true);
    expect(fixture.targets.tabs()).toHaveLength(13);
    fixture.targets.close();
  });

  it("atomically rejects invalid or oversized node grants and recovers after document replacement", async () => {
    const fixture = await started();
    expect(() => fixture.targets.rememberNodes(fixture.document, [1, -1])).toThrow("protocol");
    await expect(
      fixture.targets.command(fixture.document, "DOM.describeNode", { backendNodeId: 1 }),
    ).rejects.toThrow("scope");
    fixture.targets.rememberNodes(
      fixture.document,
      Array.from({ length: MAX_DOCUMENT_NODES }, (_value, index) => index + 1),
    );
    expect(() => fixture.targets.rememberNodes(fixture.document, [MAX_DOCUMENT_NODES + 1])).toThrow(
      "busy",
    );
    fixture.event("DOM.documentUpdated", {}, "session-1");
    const next = fixture.targets.documents(fixture.tabId)[0] as BrowserDocument;
    fixture.targets.rememberNodes(next, [MAX_DOCUMENT_NODES + 1]);
    await expect(
      fixture.targets.command(next, "DOM.describeNode", { backendNodeId: MAX_DOCUMENT_NODES + 1 }),
    ).resolves.toEqual({});
    fixture.targets.close();
  });

  it("enforces the total browser node budget across distinct pages", async () => {
    const fixture = await started();
    const pages = MAX_BROWSER_NODES / MAX_DOCUMENT_NODES;
    for (let index = 1; index <= pages; index += 1)
      fixture.attach(`extra-${index}`, `extra-session-${index}`);
    await settle();
    await settle();
    const tabs = fixture.targets.tabs();
    const nodes = Array.from({ length: MAX_DOCUMENT_NODES }, (_value, index) => index + 1);
    for (const tab of tabs.slice(0, pages))
      fixture.targets.rememberNodes(fixture.targets.documents(tab.id)[0] as BrowserDocument, nodes);
    const last = tabs.at(-1);
    if (!last) throw new Error("missing tab");
    expect(() =>
      fixture.targets.rememberNodes(fixture.targets.documents(last.id)[0] as BrowserDocument, [1]),
    ).toThrow("busy");
    fixture.targets.close();
  });

  it("obtains window geometry from an owned target and never returns the CDP window ID", async () => {
    const fixture = await started();
    await expect(fixture.targets.window(fixture.tabId)).resolves.toEqual({
      left: 0,
      top: 0,
      width: 1280,
      height: 800,
      windowState: "normal",
    });
    await fixture.targets.maximize(fixture.tabId);
    expect(fixture.writes.at(-1)).toMatchObject({
      method: "Browser.setWindowBounds",
      params: { windowId: 7, bounds: { windowState: "maximized" } },
    });
    await fixture.targets.activate(fixture.tabId);
    expect(fixture.writes.at(-1)).toMatchObject({
      method: "Target.activateTarget",
      params: { targetId: "page-1" },
    });
    fixture.targets.close();
  });

  it("contains malformed geometry without exposing private response details", async () => {
    const fixture = await started();
    fixture.intercept((command) => {
      queueMicrotask(() => fixture.reply(command, { windowId: "secret", bounds: {} }));
      return true;
    });
    await expect(fixture.targets.window(fixture.tabId)).rejects.toThrow(
      /^Browser target refused: protocol$/u,
    );
    expect(fixture.targets.closed).toBe(true);
    expect(fixture.fatal).toHaveBeenCalledTimes(1);
  });

  it("contains failed setup without publishing a ready tab", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    fixture.intercept((command) => command.method === "DOM.enable");
    const pending = expect(fixture.targets.start()).rejects.toThrow("unready");
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(fixture.targets.closed).toBe(true);
    expect(
      fixture.writes.some((command) => command.method === "Runtime.runIfWaitingForDebugger"),
    ).toBe(false);
    expect(fixture.fatal).toHaveBeenCalledTimes(1);
  });

  it("does not report startup success when Chromium supplies no page", async () => {
    const fixture = setup();
    fixture.intercept((command) => {
      queueMicrotask(() => fixture.reply(command));
      return true;
    });
    await expect(fixture.targets.start()).rejects.toThrow("unready");
    expect(fixture.targets.closed).toBe(true);
  });

  it("fences immediately on disconnect even when the containment hook throws", async () => {
    const fixture = await started();
    fixture.fatal.mockImplementation(() => {
      throw new Error("private-supervisor-canary");
    });
    fixture.disconnect();
    expect(fixture.targets.closed).toBe(true);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    await expect(fixture.targets.command(fixture.document, "Page.enable")).rejects.toThrow(
      "closed",
    );
    fixture.targets.close();
    expect(fixture.fatal).toHaveBeenCalledTimes(1);
  });
});
