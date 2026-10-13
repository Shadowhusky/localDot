import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpTransport } from "./pipe.ts";
import { BrowserTargets } from "./targets.ts";

type Command = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
type Frame = { id: string; loaderId: string; url: string; urlFragment?: string };
const owners: BrowserTargets[] = [];
const root = "review-root";
const initial: Frame = { id: root, loaderId: "initial-loader", url: "https://example.test/start" };
const destination = "https://example.test/next?review=private#public";
async function flush() {
  for (let n = 0; n < 60; n++) await Promise.resolve();
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.close();
  await flush();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

async function setup() {
  let receive = (_value: string) => {};
  let current = { ...initial };
  let intercept: ((command: Command) => boolean) | undefined;
  const commands: Command[] = [];
  const fatal = vi.fn();
  const pages = [
    {
      targetId: "owned-page",
      type: "page",
      title: "private-title",
      url: initial.url,
      attached: false,
    },
    {
      targetId: "other-page",
      type: "page",
      title: "other-private",
      url: "https://other.test/",
      attached: false,
    },
  ];
  const event = (
    method: string,
    params: unknown,
    sessionId: string | undefined = "owned-session",
  ) => receive(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  const reply = (command: Command, result: unknown = {}, sessionId = command.sessionId) =>
    receive(JSON.stringify({ id: command.id, result, ...(sessionId ? { sessionId } : {}) }));
  const transport: CdpTransport = {
    write: (raw) => {
      const command = JSON.parse(raw) as Command;
      commands.push(command);
      if (intercept?.(command)) return;
      if (command.method === "Page.navigate" || command.method === "Page.reload") return;
      queueMicrotask(() => {
        if (command.method === "Target.setDiscoverTargets")
          for (const page of pages)
            receive(
              JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: page } }),
            );
        if (command.method === "Target.setAutoAttach" && !command.sessionId)
          for (const [index, page] of pages.entries())
            receive(
              JSON.stringify({
                method: "Target.attachedToTarget",
                params: {
                  sessionId: index === 0 ? "owned-session" : "other-session",
                  targetInfo: page,
                  waitingForDebugger: true,
                },
              }),
            );
        reply(
          command,
          command.method === "Page.getFrameTree" ? { frameTree: { frame: { ...current } } } : {},
        );
      });
    },
    close: vi.fn(),
    onMessage: (listener) => {
      receive = listener;
      return () => {};
    },
    onClose: () => () => {},
  };
  const targets = new BrowserTargets(transport, {
    downloadDir: "/tmp/review-downloads",
    uploadDir: "/tmp/review-uploads",
    onFatal: fatal,
  });
  owners.push(targets);
  await targets.start();
  const tabId = targets.tabs()[0]?.id;
  if (!tabId) throw new Error("owned setup did not publish tab");
  const last = (method: string) => {
    const command = commands.findLast(
      (value) => value.method === method && value.sessionId === "owned-session",
    );
    if (!command) throw new Error(`fixture command missing: ${method}`);
    return command;
  };
  const cross = (loader = "next-loader", url = destination) => {
    current = { id: root, loaderId: loader, url };
    event("Page.frameNavigated", { frame: { ...current } });
  };
  const load = (loader = "next-loader", sessionId = "owned-session") =>
    event(
      "Page.lifecycleEvent",
      { frameId: root, loaderId: loader, name: "load", timestamp: 1 },
      sessionId,
    );
  return {
    targets,
    tabId,
    commands,
    fatal,
    event,
    reply,
    last,
    cross,
    load,
    setFrame: (frame: Frame) => {
      current = { ...frame };
    },
    intercept: (handler: (command: Command) => boolean) => {
      intercept = handler;
    },
  };
}

const outcome = (work: Promise<unknown>) =>
  work.then(
    () => "complete",
    () => "refused",
  );
describe("independent root navigation boundaries", () => {
  it("P1 dispatches exactly the requested URL and returns no private result", async () => {
    const f = await setup();
    const old = f.targets.documents(f.tabId)[0];
    const work = f.targets.navigate(f.tabId, destination);
    await flush();
    expect(f.last("Page.navigate").params).toEqual({ url: destination });
    f.cross();
    f.load();
    f.reply(f.last("Page.navigate"), { frameId: root, loaderId: "next-loader" });
    await expect(work).resolves.toBeUndefined();
    expect(f.fatal).not.toHaveBeenCalled();
    expect(() => old && f.targets.check(old)).toThrow();
  });
  it("B1 another owned page cannot supply navigation or load for this tab", async () => {
    const f = await setup();
    let settled = false;
    const work = outcome(f.targets.navigate(f.tabId, destination)).finally(() => {
      settled = true;
    });
    await flush();
    f.reply(f.last("Page.navigate"), { frameId: root, loaderId: "next-loader" });
    f.event(
      "Page.frameNavigated",
      { frame: { id: root, loaderId: "next-loader", url: destination } },
      "other-session",
    );
    f.load("next-loader", "other-session");
    await flush();
    expect(settled).toBe(false);
    f.cross();
    f.load();
    expect(await work).toBe("complete");
    expect(f.fatal).not.toHaveBeenCalled();
  });
  it("B2 a load observed before dispatch cannot satisfy the requested navigation", async () => {
    const f = await setup();
    f.intercept((command) => {
      if (
        command.method === "Page.getFrameTree" &&
        !f.commands.some((entry) => entry.method === "Page.navigate")
      )
        f.load();
      return false;
    });
    let settled = false;
    const work = outcome(f.targets.navigate(f.tabId, destination)).finally(() => {
      settled = true;
    });
    await flush();
    f.cross();
    f.reply(f.last("Page.navigate"), { frameId: root, loaderId: "next-loader" });
    await flush();
    expect(settled).toBe(false);
    f.load();
    expect(await work).toBe("complete");
  });
  it("B3 a second root during final frame read cannot publish the first completion", async () => {
    const f = await setup();
    let final: Command | undefined;
    f.intercept((command) => {
      if (
        command.method === "Page.getFrameTree" &&
        f.commands.some((entry) => entry.method === "Page.navigate")
      ) {
        final = command;
        return true;
      }
      return false;
    });
    const work = outcome(f.targets.navigate(f.tabId, destination));
    await flush();
    f.cross();
    f.load();
    f.reply(f.last("Page.navigate"), { frameId: root, loaderId: "next-loader" });
    await flush();
    expect(final).toBeDefined();
    f.cross("replacement-loader", "https://example.test/replaced");
    if (final)
      f.reply(final, {
        frameTree: { frame: { id: root, loaderId: "next-loader", url: destination } },
      });
    expect(await work).toBe("refused");
    expect(f.fatal).toHaveBeenCalledOnce();
  });
  it("B4 fragment navigation with a later root replacement refuses", async () => {
    const f = await setup();
    const url = `${initial.url}#fragment`;
    let final: Command | undefined;
    f.intercept((command) => {
      if (
        command.method === "Page.getFrameTree" &&
        f.commands.some((entry) => entry.method === "Page.navigate")
      ) {
        final = command;
        return true;
      }
      return false;
    });
    const work = outcome(f.targets.navigate(f.tabId, url));
    await flush();
    f.reply(f.last("Page.navigate"), { frameId: root });
    f.setFrame({ ...initial, urlFragment: "#fragment" });
    f.event("Page.navigatedWithinDocument", { frameId: root, url });
    await flush();
    expect(final).toBeDefined();
    f.cross();
    expect(await work).toBe("refused");
    expect(f.fatal).toHaveBeenCalledOnce();
  });
  it("B5 a changed preflight releases the slot without dispatch or retirement", async () => {
    const f = await setup();
    let enabled: Command | undefined;
    f.intercept((command) => {
      if (command.method === "Page.setLifecycleEventsEnabled") {
        enabled = command;
        return true;
      }
      return false;
    });
    const work = outcome(f.targets.navigate(f.tabId, destination));
    await flush();
    expect(enabled).toBeDefined();
    f.event("DOM.documentUpdated", {});
    if (enabled) f.reply(enabled);
    await flush();
    expect(f.commands.filter((entry) => entry.method === "Page.navigate")).toHaveLength(0);
    expect(await work).toBe("refused");
    expect(f.fatal).not.toHaveBeenCalled();
    f.intercept(() => false);
    const retry = f.targets.navigate(f.tabId, destination);
    await flush();
    f.cross();
    f.load();
    f.reply(f.last("Page.navigate"), { frameId: root, loaderId: "next-loader" });
    await expect(retry).resolves.toBeUndefined();
  });
  it("B6 repeated success releases listeners and per-target admission", async () => {
    const f = await setup();
    for (let index = 0; index < 36; index++) {
      const url = `https://example.test/iteration/${index}`;
      const loader = `iteration-${index}`;
      const work = f.targets.navigate(f.tabId, url);
      await flush();
      f.cross(loader, url);
      f.load(loader);
      f.reply(f.last("Page.navigate"), { frameId: root, loaderId: loader });
      await expect(work).resolves.toBeUndefined();
    }
    expect(f.commands.filter((entry) => entry.method === "Page.navigate")).toHaveLength(36);
    expect(f.fatal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("B7 closing while the final read is pending rejects and ignores a late valid reply", async () => {
    const f = await setup();
    let final: Command | undefined;
    f.intercept((command) => {
      if (
        command.method === "Page.getFrameTree" &&
        f.commands.some((entry) => entry.method === "Page.navigate")
      ) {
        final = command;
        return true;
      }
      return false;
    });
    const work = outcome(f.targets.navigate(f.tabId, destination));
    await flush();
    f.cross();
    f.load();
    f.reply(f.last("Page.navigate"), { frameId: root, loaderId: "next-loader" });
    await flush();
    expect(final).toBeDefined();
    f.targets.close();
    if (final)
      f.reply(final, {
        frameTree: { frame: { id: root, loaderId: "next-loader", url: destination } },
      });
    expect(await work).toBe("refused");
    expect(f.fatal).toHaveBeenCalledOnce();
  });
  it("B8 a final read owned by another session cannot publish completion", async () => {
    const f = await setup();
    f.intercept((command) => {
      if (
        command.method === "Page.getFrameTree" &&
        f.commands.some((entry) => entry.method === "Page.navigate")
      ) {
        f.reply(
          command,
          { frameTree: { frame: { id: root, loaderId: "next-loader", url: destination } } },
          "other-session",
        );
        return true;
      }
      return false;
    });
    const work = outcome(f.targets.navigate(f.tabId, destination));
    await flush();
    f.cross();
    f.load();
    f.reply(f.last("Page.navigate"), { frameId: root, loaderId: "next-loader" });
    expect(await work).toBe("refused");
    expect(f.fatal).toHaveBeenCalledOnce();
  });
});
