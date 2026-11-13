import { NOTIFY_COPY } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import manifestText from "../../public/manifest.webmanifest?raw";
import worker from "../../public/sw.js?raw";

const SESSION = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
type Listener = (event: Record<string, unknown>) => void;

function load(
  windows: {
    url: string;
    focus: () => Promise<void>;
    postMessage: (m: { type?: string }, transfer?: MessagePort[]) => void;
  }[] = [],
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

  // One notification per task and kind replaces the last, as a phone stacks them; a browser does
  // that silently unless asked to alert again, so a second question from the same task would
  // arrive with no banner.
  it("alerts again when the same task needs you again", async () => {
    const sw = load();
    await sw.push({ kind: "needs_you", sessionId: SESSION });
    await sw.push({ kind: "needs_you", sessionId: SESSION });
    expect(sw.shown.map((n) => n.options)).toEqual([
      expect.objectContaining({ tag: `needs_you:${SESSION}`, renotify: true }),
      expect.objectContaining({ tag: `needs_you:${SESSION}`, renotify: true }),
    ]);
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

  // An installed app's window, asked, says so; a browser tab, or a page too old or too busy to
  // answer, doesn't. A tap goes to the app, as the app's own notifications do.
  const window = (url: string, standalone?: boolean) => {
    const client = {
      url,
      focus: vi.fn(async () => {}),
      postMessage: vi.fn((message: { type?: string }, transfer?: MessagePort[]) => {
        if (message.type === "display-mode" && standalone !== undefined)
          transfer?.[0]?.postMessage({ standalone });
      }),
    };
    return client;
  };

  it("takes a tap to the installed app's window over a browser tab", async () => {
    const tab = window("https://mac.example.ts.net/", false);
    const silent = window("https://mac.example.ts.net/?replay=x");
    const app = window("https://mac.example.ts.net/", true);
    const sw = load([tab, silent, app]);
    await sw.dispatch("notificationclick", {
      notification: { close: vi.fn(), data: { sessionId: SESSION } },
    });
    expect(app.focus).toHaveBeenCalledOnce();
    expect(app.postMessage).toHaveBeenLastCalledWith({ type: "open-session", sessionId: SESSION });
    expect(tab.focus).not.toHaveBeenCalled();
    expect(silent.focus).not.toHaveBeenCalled();
    expect(sw.opened).toEqual([]);
  });

  it("takes a tap to the latest window when no app's is open, however long the others take", async () => {
    const tab = window("https://mac.example.ts.net/", false);
    const silent = window("https://mac.example.ts.net/");
    const sw = load([silent, tab]);
    const started = Date.now();
    await sw.dispatch("notificationclick", {
      notification: { close: vi.fn(), data: { sessionId: SESSION } },
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(silent.focus).toHaveBeenCalledOnce();
    expect(tab.focus).not.toHaveBeenCalled();
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

describe("a page load while localDot is down", () => {
  function fetching() {
    const listeners = new Map<string, Listener>();
    new Function("self", worker)({
      location: { origin: "https://mac.example.ts.net" },
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn() },
    });
    return async (mode: string) => {
      let answer: Promise<Response> | undefined;
      listeners.get("fetch")?.({
        request: { mode, url: "https://mac.example.ts.net/" },
        respondWith: (response: Promise<Response>) => {
          answer = response;
        },
      });
      return answer;
    };
  }
  it("answers with a page that waits when localDot can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("refused")));
    const answer = await (await fetching())("navigate");
    expect(answer?.headers.get("content-type")).toContain("text/html");
    const page = await answer?.text();
    expect(page).toContain("localDot is restarting");
    expect(page).toContain("/healthz");
    expect(page).toContain("localdot.app-update");
    vi.unstubAllGlobals();
  });
  it("does the same for a front answering for it, and passes anything else through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 502 })));
    expect(await (await (await fetching())("navigate"))?.text()).toContain(
      "localDot is restarting",
    );
    const fine = new Response("app");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fine));
    expect(await (await fetching())("navigate")).toBe(fine);
    vi.unstubAllGlobals();
  });
  it("leaves every other request alone, so it never stands between the app and its API", async () => {
    const fetchFile = vi.fn();
    vi.stubGlobal("fetch", fetchFile);
    expect(await (await fetching())("cors")).toBeUndefined();
    expect(fetchFile).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("holds no sign-in token and caches nothing", () => {
    expect(worker).not.toMatch(/caches\.|Authorization|daemon-token/i);
  });
});
