import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpTransport } from "./pipe.ts";
import { BrowserTargets, MAX_BROWSER_TARGETS } from "./targets.ts";

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
afterEach(() => vi.useRealTimers());

describe("independent initialization queue bound", () => {
  it("retired target churn cannot retain more queued initializations than the target cap", async () => {
    const f = await started();
    f.intercept((c) => Boolean(c.sessionId));
    for (let i = 0; i < 4; i++) f.attach(`held-${i}`, `held-session-${i}`);
    const admittedWrites = f.writes.length;
    let observedQueue: unknown[] | undefined;
    const originalPush = Array.prototype.push;
    const originalDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "push");
    if (!originalDescriptor) throw new Error("missing private-process array descriptor");
    Object.defineProperty(Array.prototype, "push", {
      ...originalDescriptor,
      value: function (this: unknown[], ...values: unknown[]) {
        const value = values[0];
        // Observe storage ownership only; delegate every push unchanged. No production source is patched.
        if (
          value &&
          typeof value === "object" &&
          "targetId" in value &&
          typeof value.targetId === "string" &&
          value.targetId.startsWith("churn-") &&
          "nodes" in value &&
          value.nodes instanceof Set
        )
          observedQueue = this;
        return Reflect.apply(originalPush, this, values);
      },
    });
    try {
      for (let i = 0; i < MAX_BROWSER_TARGETS + 20; i++) {
        f.attach(`churn-${i}`, `churn-session-${i}`);
        f.event("Target.targetDestroyed", { targetId: `churn-${i}` });
      }
      expect(f.writes).toHaveLength(admittedWrites);
      expect(f.targets.tabs()).toHaveLength(5);
      expect(observedQueue).toBeDefined();
      expect(observedQueue?.length).toBeLessThanOrEqual(MAX_BROWSER_TARGETS);
    } finally {
      Object.defineProperty(Array.prototype, "push", originalDescriptor);
      f.targets.close();
      await settle();
    }
  });
});
