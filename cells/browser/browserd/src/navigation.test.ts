import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_NAVIGATION_TIMEOUT_MS, MAX_NAVIGATION_EVENTS } from "./navigation.ts";
import type { CdpTransport } from "./pipe.ts";
import { BrowserTargets } from "./targets.ts";

interface WireCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

const initialFrame = { id: "root", loaderId: "old-loader", url: "https://example.test/start" };
const destination = "https://example.test/next";
const runtimes: BrowserTargets[] = [];

async function settle() {
  for (let step = 0; step < 40; step += 1) await Promise.resolve();
}

async function setup() {
  let receive = (_message: string) => {};
  let frame: Record<string, unknown> = { ...initialFrame };
  let intercept: ((command: WireCommand) => boolean) | undefined;
  const writes: WireCommand[] = [];
  const fatal = vi.fn();
  const close = vi.fn();
  const info = {
    targetId: "page",
    type: "page",
    title: "private",
    url: initialFrame.url,
    attached: false,
  };
  const event = (method: string, params: unknown, sessionId: string | null = "session") => {
    receive(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  };
  const reply = (command: WireCommand, result: unknown = {}) => {
    receive(
      JSON.stringify({
        id: command.id,
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        result,
      }),
    );
  };
  const transport: CdpTransport = {
    write: (message) => {
      const command = JSON.parse(message) as WireCommand;
      writes.push(command);
      if (intercept?.(command)) return;
      if (["Page.navigate", "Page.reload"].includes(command.method)) return;
      queueMicrotask(() => {
        if (command.method === "Target.setDiscoverTargets")
          event("Target.targetCreated", { targetInfo: info }, null);
        if (command.method === "Target.setAutoAttach" && !command.sessionId)
          event(
            "Target.attachedToTarget",
            { sessionId: "session", targetInfo: info, waitingForDebugger: true },
            null,
          );
        reply(command, command.method === "Page.getFrameTree" ? { frameTree: { frame } } : {});
      });
    },
    close,
    onMessage: (listener) => {
      receive = listener;
      return () => {};
    },
    onClose: () => () => {},
  };
  const targets = new BrowserTargets(transport, {
    downloadDir: "/tmp/downloads",
    uploadDir: "/tmp/uploads",
    onFatal: fatal,
  });
  runtimes.push(targets);
  await targets.start();
  const tab = targets.tabs()[0];
  if (!tab) throw new Error("missing owned fixture tab");
  return {
    targets,
    tabId: tab.id,
    writes,
    fatal,
    close,
    event,
    reply,
    setFrame: (next: Record<string, unknown>) => {
      frame = next;
    },
    intercept: (handler: (command: WireCommand) => boolean) => {
      intercept = handler;
    },
    navigation: () => {
      const command = writes.findLast((entry) => entry.method === "Page.navigate");
      if (!command) throw new Error("navigation not dispatched");
      return command;
    },
    load: (loaderId = "new-loader", frameId = "root", name = "load") =>
      event("Page.lifecycleEvent", { frameId, loaderId, name, timestamp: 1 }),
    cross: () => {
      frame = { id: "root", loaderId: "new-loader", url: destination };
      event("Page.frameNavigated", { frame });
    },
  };
}

afterEach(() => {
  for (const targets of runtimes.splice(0)) targets.close();
  vi.useRealTimers();
});

describe("owned root navigation", () => {
  it.each([{ enabled: false }, { enabled: true, extra: true }])(
    "keeps lifecycle enable narrowly guarded %#",
    async (params) => {
      const fixture = await setup();
      const document = fixture.targets.documents(fixture.tabId)[0];
      if (!document) throw new Error("missing fixture document");
      const before = fixture.writes.length;
      await expect(
        fixture.targets.command(document, "Page.setLifecycleEventsEnabled", params),
      ).rejects.toThrow();
      expect(fixture.writes).toHaveLength(before);
      expect(fixture.fatal).not.toHaveBeenCalled();
    },
  );

  it("accepts the finite early-load event boundary", async () => {
    const fixture = await setup();
    const result = fixture.targets.navigate(fixture.tabId, destination);
    await settle();
    for (let index = 0; index < MAX_NAVIGATION_EVENTS - 2; index += 1)
      fixture.load(`foreign-${index}`);
    fixture.cross();
    fixture.load();
    fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
    await expect(result).resolves.toBeUndefined();
    expect(fixture.fatal).not.toHaveBeenCalled();
  });

  it.each(["events-first", "ack-first"])("correlates one loaded root (%s)", async (order) => {
    const fixture = await setup();
    const oldDocument = fixture.targets.documents(fixture.tabId)[0];
    const result = fixture.targets.navigate(fixture.tabId, destination);
    await settle();
    if (order === "ack-first")
      fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
    fixture.cross();
    fixture.load();
    if (order === "events-first")
      fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
    await expect(result).resolves.toBeUndefined();
    expect(fixture.fatal).not.toHaveBeenCalled();
    expect(fixture.writes.filter((entry) => entry.method === "Page.navigate")).toHaveLength(1);
    expect(fixture.writes.at(-1)?.method).toBe("Page.getFrameTree");
    expect(() => oldDocument && fixture.targets.check(oldDocument)).toThrow();
  });

  it.each(["events-first", "ack-first"])(
    "keeps a DOM-ready sign-in page usable while another resource is pending (%s)",
    async (order) => {
      const fixture = await setup();
      const result = fixture.targets.navigate(fixture.tabId, destination);
      await settle();
      if (order === "ack-first")
        fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
      fixture.cross();
      fixture.load("new-loader", "root", "DOMContentLoaded");
      if (order === "events-first")
        fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
      // No full-load event: this document must still be available for inspection and sign-in.
      await expect(result).resolves.toBeUndefined();
      expect(fixture.fatal).not.toHaveBeenCalled();
      expect(fixture.targets.closed).toBe(false);
      expect(fixture.targets.documents(fixture.tabId)).toHaveLength(1);
      expect(fixture.writes.filter((entry) => entry.method === "Page.navigate")).toHaveLength(1);
    },
  );

  it.each(["event-first", "ack-first"])("matches same-document fragments (%s)", async (order) => {
    const fixture = await setup();
    const url = `${initialFrame.url}#part`;
    const result = fixture.targets.navigate(fixture.tabId, url);
    await settle();
    if (order === "ack-first") fixture.reply(fixture.navigation(), { frameId: "root" });
    fixture.setFrame({ ...initialFrame, urlFragment: "#part" });
    fixture.event("Page.navigatedWithinDocument", { frameId: "root", url });
    if (order === "event-first") fixture.reply(fixture.navigation(), { frameId: "root" });
    await expect(result).resolves.toBeUndefined();
    expect(fixture.fatal).not.toHaveBeenCalled();
  });

  it.each([
    "file:///tmp/private",
    "http://localhost/",
    "https://127.0.0.1/",
    "https://user:secret@example.test/",
    "https://example.test:444/",
    "javascript:alert(1)",
    "https://example.test/ bad",
  ])("rejects unsafe URL before any command: %s", async (url) => {
    const fixture = await setup();
    const before = fixture.writes.length;
    await expect(fixture.targets.navigate(fixture.tabId, url)).rejects.toThrow();
    expect(fixture.writes).toHaveLength(before);
    expect(fixture.fatal).not.toHaveBeenCalled();
  });

  it("already cancelled requests send nothing and do not retire", async () => {
    const fixture = await setup();
    const before = fixture.writes.length;
    await expect(
      fixture.targets.navigate(fixture.tabId, destination, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(fixture.writes).toHaveLength(before);
    expect(fixture.fatal).not.toHaveBeenCalled();
  });

  it("ignores old-loader, child-frame and generic load events", async () => {
    const fixture = await setup();
    let settled = false;
    const result = fixture.targets.navigate(fixture.tabId, destination).finally(() => {
      settled = true;
    });
    await settle();
    fixture.cross();
    fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
    fixture.load("old-loader");
    fixture.load("new-loader", "child");
    fixture.load("old-loader", "root", "DOMContentLoaded");
    fixture.load("new-loader", "child", "DOMContentLoaded");
    fixture.load("new-loader", "root", "init");
    fixture.event("Page.loadEventFired", { timestamp: 5 });
    await settle();
    expect(settled).toBe(false);
    fixture.load();
    await result;
  });

  it.each([
    { frameId: "different", loaderId: "new-loader" },
    { frameId: "root", loaderId: "old-loader" },
    { frameId: "root", loaderId: "new-loader", errorText: "private failure" },

    { frameId: "root", loaderId: 7 },
    {},
  ])("refuses malformed, old or unsuccessful acknowledgement %#", async (acknowledgement) => {
    const fixture = await setup();
    const result = fixture.targets.navigate(fixture.tabId, destination);
    const refused = expect(result).rejects.toThrow("Browser navigation refused");
    await settle();
    fixture.reply(fixture.navigation(), acknowledgement);
    await refused;
    expect(fixture.fatal).toHaveBeenCalledTimes(1);
    expect(fixture.targets.closed).toBe(true);
  });

  it.each([undefined, "net::ERR_ABORTED"])(
    "keeps control after a download (%s)",
    async (errorText) => {
      const f = await setup();
      const result = f.targets.navigate(f.tabId, "https://example.test/source.zip");
      await settle();
      f.reply(f.navigation(), {
        frameId: "root",
        loaderId: "download-loader",
        isDownload: true,
        errorText,
      });
      await expect(result).resolves.toBe("download");
      expect(f.targets.closed).toBe(false);
      expect(f.fatal).not.toHaveBeenCalled();
      const next = f.targets.navigate(f.tabId, destination);
      await settle();
      f.cross();
      f.load();
      f.reply(f.navigation(), { frameId: "root", loaderId: "new-loader" });
      await expect(next).resolves.toBeUndefined();
    },
  );

  it.each(["frame", "loader", "url", "event", "error"])(
    "refuses a download with changed %s",
    async (kind) => {
      const f = await setup();
      const result = f.targets.navigate(f.tabId, destination);
      const refused = expect(result).rejects.toThrow();
      await settle();
      if (kind === "frame") f.setFrame({ ...initialFrame, id: "other" });
      if (kind === "loader") f.setFrame({ ...initialFrame, loaderId: "other" });
      if (kind === "url") f.setFrame({ ...initialFrame, url: destination });
      if (kind === "event") f.cross();
      f.reply(f.navigation(), {
        frameId: "root",
        isDownload: true,
        ...(kind === "error" ? { errorText: "net::ERR_FAILED" } : {}),
      });
      await refused;
      expect(f.fatal).toHaveBeenCalledOnce();
    },
  );

  it.each(["second-root", "wrong-loader", "wrong-root", "unexpected-fragment"])(
    "retires ambiguous root events: %s",
    async (kind) => {
      const fixture = await setup();
      const result = fixture.targets.navigate(fixture.tabId, destination);
      const refused = expect(result).rejects.toThrow();
      await settle();
      fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
      if (kind === "wrong-root")
        fixture.event("Page.frameNavigated", {
          frame: { id: "other", loaderId: "new-loader", url: destination },
        });
      else if (kind === "wrong-loader")
        fixture.event("Page.frameNavigated", {
          frame: { id: "root", loaderId: "foreign-loader", url: destination },
        });
      else if (kind === "second-root") {
        fixture.cross();
        fixture.cross();
      } else {
        // The old document's own history change, before the requested one commits.
        fixture.event("Page.navigatedWithinDocument", {
          frameId: "root",
          url: `${initialFrame.url}#foreign`,
        });
        fixture.cross();
      }
      fixture.load();
      await refused;
      expect(fixture.fatal).toHaveBeenCalledTimes(1);
    },
  );

  // Sign-in pages (Google, Microsoft, GitHub) rewrite their own URL with history.replaceState
  // before they finish loading. The document is still the one this navigation committed.
  it.each(["events-first", "ack-first"])(
    "keeps the loading document's own history changes (%s)",
    async (order) => {
      const fixture = await setup();
      const replaced = `${destination}?flow=signin`;
      const result = fixture.targets.navigate(fixture.tabId, destination);
      await settle();
      if (order === "ack-first")
        fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
      fixture.cross();
      fixture.event("Page.navigatedWithinDocument", { frameId: "root", url: replaced });
      fixture.event("Page.navigatedWithinDocument", { frameId: "root", url: `${replaced}#step` });
      fixture.setFrame({ id: "root", loaderId: "new-loader", url: replaced });
      fixture.load();
      if (order === "events-first")
        fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
      await expect(result).resolves.toBeUndefined();
      expect(fixture.fatal).not.toHaveBeenCalled();
    },
  );

  it.each(["root", "loader", "scheme"])("rechecks the final frame's %s", async (kind) => {
    const fixture = await setup();
    const result = fixture.targets.navigate(fixture.tabId, destination);
    const refused = expect(result).rejects.toThrow();
    await settle();
    fixture.cross();
    fixture.load();
    fixture.setFrame({
      id: kind === "root" ? "foreign" : "root",
      loaderId: kind === "loader" ? "foreign" : "new-loader",
      url: kind === "scheme" ? "data:text/plain,no" : destination,
    });
    fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
    await refused;
    expect(fixture.fatal).toHaveBeenCalledTimes(1);
  });

  it.each(["event-url", "final-url", "final-loader", "root-change"])(
    "refuses same-document mismatch: %s",
    async (kind) => {
      const fixture = await setup();
      const url = `${initialFrame.url}#requested`;
      const result = fixture.targets.navigate(fixture.tabId, url);
      const refused = expect(result).rejects.toThrow();
      await settle();
      fixture.reply(fixture.navigation(), { frameId: "root" });
      if (kind === "root-change") fixture.cross();
      else
        fixture.event("Page.navigatedWithinDocument", {
          frameId: "root",
          url: kind === "event-url" ? `${initialFrame.url}#other` : url,
        });
      fixture.setFrame({
        ...initialFrame,
        loaderId: kind === "final-loader" ? "other" : initialFrame.loaderId,
        url: kind === "final-url" ? initialFrame.url : url,
      });
      await refused;
      expect(fixture.fatal).toHaveBeenCalledTimes(1);
    },
  );

  it("changed preflight document sends no navigation", async () => {
    const fixture = await setup();
    fixture.intercept((command) => {
      if (command.method !== "Page.getFrameTree") return false;
      fixture.event("DOM.documentUpdated", {});
      fixture.reply(command, { frameTree: { frame: initialFrame } });
      return true;
    });
    await expect(fixture.targets.navigate(fixture.tabId, destination)).rejects.toThrow();
    expect(fixture.writes.some((entry) => entry.method === "Page.navigate")).toBe(false);
    expect(fixture.fatal).not.toHaveBeenCalled();
  });

  it("reload and navigation share their per-target slot", async () => {
    const fixture = await setup();
    const result = fixture.targets.navigate(fixture.tabId, destination);
    await settle();
    await expect(fixture.targets.navigate(fixture.tabId, destination)).rejects.toThrow("busy");
    await expect(fixture.targets.reload(fixture.tabId)).rejects.toThrow("busy");
    fixture.cross();
    fixture.load();
    fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
    await result;
    expect(fixture.writes.filter((entry) => entry.method === "Page.navigate")).toHaveLength(1);
  });

  it.each(["before-ack", "after-ack"])(
    "cancellation retires dispatched work: %s",
    async (phase) => {
      const fixture = await setup();
      const controller = new AbortController();
      const result = fixture.targets.navigate(fixture.tabId, destination, controller.signal);
      const refused = expect(result).rejects.toThrow();
      await settle();
      if (phase === "after-ack") {
        fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
        await settle();
      }
      controller.abort();
      await refused;
      expect(fixture.fatal).toHaveBeenCalledTimes(1);
    },
  );

  it("removing the owned target cancels the navigation", async () => {
    const fixture = await setup();
    const result = fixture.targets.navigate(fixture.tabId, destination);
    const refused = expect(result).rejects.toThrow();
    await settle();
    fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
    fixture.event("Target.targetDestroyed", { targetId: "page" }, null);
    await refused;
    expect(fixture.fatal).toHaveBeenCalledTimes(1);
  });

  it("bounds unmatched early root load events", async () => {
    const fixture = await setup();
    const result = fixture.targets.navigate(fixture.tabId, destination);
    const refused = expect(result).rejects.toThrow();
    await settle();
    for (let index = 0; index <= MAX_NAVIGATION_EVENTS; index += 1)
      fixture.load(`foreign-${index}`);
    await refused;
    expect(fixture.fatal).toHaveBeenCalledTimes(1);
  });

  it.each(["missing-ack", "missing-load"])("bounds a %s", async (kind) => {
    vi.useFakeTimers();
    const fixture = await setup();
    const result = fixture.targets.navigate(fixture.tabId, destination);
    const refused = expect(result).rejects.toThrow();
    await settle();
    if (kind === "missing-load")
      fixture.reply(fixture.navigation(), { frameId: "root", loaderId: "new-loader" });
    await vi.advanceTimersByTimeAsync(BROWSER_NAVIGATION_TIMEOUT_MS);
    await refused;
    expect(fixture.fatal).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
