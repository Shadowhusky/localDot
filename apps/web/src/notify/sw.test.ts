import { NOTIFY_COPY } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import manifestText from "../../public/manifest.webmanifest?raw";
import worker from "../../public/sw.js?raw";

const SESSION = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
type Listener = (event: Record<string, unknown>) => void;

function load(
  windows: { url: string; focus: () => Promise<void>; postMessage: (m: unknown) => void }[] = [],
) {
  const listeners = new Map<string, Listener>();
  const shown: {
    title: string;
    options: { body: string; tag: string; data: { sessionId: string | null } };
  }[] = [];
  const opened: string[] = [];
  const scope = {
    location: { origin: "https://mac.example.ts.net" },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(),
    registration: {
      showNotification: async (title: string, options: (typeof shown)[number]["options"]) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: vi.fn(),
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
  };
  new Function("self", worker)(scope);
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get(type)?.({
      ...event,
      waitUntil: (p: Promise<unknown>) => {
        done = p;
      },
    });
    await done;
  };
  const push = (payload: unknown) =>
    dispatch("push", {
      data: {
        json: () => {
          if (payload === "garbage") throw new SyntaxError("bad json");
          return payload;
        },
      },
    });
  return { shown, opened, dispatch, push, listeners };
}

describe("service worker", () => {
  it("shows the same copy the daemon uses for every kind", async () => {
    const sw = load();
    for (const kind of Object.keys(NOTIFY_COPY) as (keyof typeof NOTIFY_COPY)[]) {
      await sw.push({ kind, sessionId: SESSION });
      expect(sw.shown.at(-1)).toMatchObject({
        title: NOTIFY_COPY[kind].title,
        options: {
          body: NOTIFY_COPY[kind].body,
          tag: `${kind}:${SESSION}`,
          data: { sessionId: SESSION },
        },
      });
    }
  });

  it("shows the task's title only when the payload carries one", async () => {
    const sw = load();
    await sw.push({ kind: "done", sessionId: SESSION, title: "Pay the electricity bill" });
    expect(sw.shown[0]?.options.body).toBe("Pay the electricity bill");
  });

  it("stays neutral for unknown, damaged or hostile payloads", async () => {
    const sw = load();
    await sw.push("garbage");
    await sw.push({ kind: "__proto__", sessionId: "../../evil" });
    expect(sw.shown.map((n) => [n.title, n.options.data.sessionId])).toEqual([
      ["localDot", null],
      ["localDot", null],
    ]);
  });

  it("opens the task in a new window, or focuses an open one and tells it which", async () => {
    const sw = load();
    const close = vi.fn();
    await sw.dispatch("notificationclick", {
      notification: { close, data: { sessionId: SESSION } },
    });
    expect(close).toHaveBeenCalled();
    expect(sw.opened).toEqual([`/#session=${SESSION}`]);

    const focus = vi.fn(async () => {});
    const postMessage = vi.fn();
    const withWindow = load([
      { url: "https://other.example/", focus: vi.fn(async () => {}), postMessage: vi.fn() },
      { url: "https://mac.example.ts.net/?replay=x", focus, postMessage },
    ]);
    await withWindow.dispatch("notificationclick", {
      notification: { close: vi.fn(), data: { sessionId: SESSION } },
    });
    expect(focus).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: "open-session", sessionId: SESSION });
    expect(withWindow.opened).toEqual([]);
  });

  it("caches nothing: no fetch handler", () => {
    expect(load().listeners.has("fetch")).toBe(false);
  });

  it("is a standalone Home Screen app on the void colour", () => {
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#0a0b0d",
      theme_color: "#0a0b0d",
    });
    expect(JSON.stringify(manifest.icons)).toContain("maskable");
  });
});
