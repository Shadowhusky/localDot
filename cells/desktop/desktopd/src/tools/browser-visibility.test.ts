import { describe, expect, it, vi } from "vitest";
import type { HelperWindow } from "../perception/hit-test.ts";
import { fakeCdp, fakeTargets } from "../testing/fake-cdp.ts";
import { NavigationError, PageBrowser } from "./browser.ts";

const windowFor = (title: string, id = 1): HelperWindow => ({
  id,
  pid: 100,
  cls: "Chromium",
  title: `${title} - Chromium`,
  x: 0,
  y: 0,
  w: 1280,
  h: 800,
  frame: [0, 0, 1280, 800],
  active: true,
  overrideRedirect: false,
  transientFor: null,
});
const pages = [
  { type: "page", url: "https://background.test/", title: "Background" },
  { type: "page", url: "http://localhost:3500/", title: "Visible" },
];

function connection(handler: Parameters<typeof fakeCdp>[0]) {
  const fixture = fakeCdp(handler);
  const connected: string[] = [];
  class Socket extends fixture.WebSocketImpl {
    constructor(url: string) {
      super(url);
      connected.push(url);
    }
  }
  return { ...fixture, WebSocketImpl: Socket as typeof fixture.WebSocketImpl, connected };
}

describe("desktop browser visible page binding", () => {
  it("reads the native foreground page even when CDP lists a background tab first", async () => {
    const peer = connection((method) =>
      method === "Runtime.evaluate"
        ? { result: { value: { ...pages[1], text: "Visible content" } } }
        : {},
    );
    const browser = new PageBrowser({
      ...peer,
      fetchImpl: fakeTargets(pages),
      window: async () => windowFor("Visible"),
    });
    expect(await browser.page()).toEqual({ url: pages[1]?.url });
    expect(await browser.read(500)).toMatchObject({ text: "Visible content" });
    expect(peer.connected).toEqual(["ws://127.0.0.1:9222/devtools/page/t1"]);
    expect(peer.sent).not.toContain("Page.bringToFront");
  });

  it("reveals the identified browser before reading when another app covers it", async () => {
    let focused = false;
    const peer = connection((method) => {
      if (method === "Page.bringToFront") focused = true;
      return method === "Runtime.evaluate"
        ? { result: { value: { ...pages[1], text: "Visible content" } } }
        : {};
    });
    const browser = new PageBrowser({
      ...peer,
      fetchImpl: fakeTargets(pages),
      window: async () => ({ ...windowFor("Visible"), active: focused }),
    });
    // Passive inventory must not move the user's windows.
    expect(await browser.page()).toEqual({ url: pages[1]?.url });
    expect(peer.sent).toEqual([]);
    expect(await browser.read(500)).toMatchObject({ text: "Visible content" });
    expect(peer.sent.filter((method) => method === "Page.bringToFront")).toHaveLength(1);
    expect(peer.sent.indexOf("Page.bringToFront")).toBeLessThan(
      peer.sent.indexOf("Runtime.evaluate"),
    );
    expect(peer.connected).toEqual(["ws://127.0.0.1:9222/devtools/page/t1"]);
  });

  it("does not read hidden content when the window cannot be revealed", async () => {
    const peer = connection(() => ({}));
    const browser = new PageBrowser({
      ...peer,
      fetchImpl: fakeTargets(pages),
      window: async () => ({ ...windowFor("Visible"), active: false }),
    });
    await expect(browser.read(500)).rejects.toThrow(/did not receive focus/);
    expect(peer.sent).toEqual(["Page.bringToFront"]);
  });

  it("stops revealing and reading as soon as control is taken", async () => {
    const abort = new AbortController();
    const peer = connection((method) => {
      if (method === "Page.bringToFront") abort.abort(new Error("control taken"));
      return {};
    });
    const browser = new PageBrowser({
      ...peer,
      fetchImpl: fakeTargets(pages),
      window: async () => ({ ...windowFor("Visible"), active: false }),
    });
    await expect(browser.read(500, abort.signal)).rejects.toThrow("control taken");
    expect(peer.sent).toEqual(["Page.bringToFront"]);
  });

  it("does not return a page hidden by another window during a read", async () => {
    let focused = true;
    const peer = connection((method) => {
      if (method === "Runtime.evaluate") {
        focused = false;
        return { result: { value: { ...pages[1], text: "Hidden content" } } };
      }
      return {};
    });
    const browser = new PageBrowser({
      ...peer,
      fetchImpl: fakeTargets(pages),
      window: async () => ({ ...windowFor("Visible"), active: focused }),
    });
    await expect(browser.read(500)).rejects.toThrow(/did not receive focus/);
    expect(peer.sent).not.toContain("Page.bringToFront");
  });

  it.each(["no native window", "ambiguous titles", "no native provider"])(
    "refuses %s without opening a background tab or reporting no browser",
    async (scenario) => {
      const peer = connection(() => ({}));
      const browser = new PageBrowser({
        ...peer,
        fetchImpl: fakeTargets(
          scenario === "ambiguous titles"
            ? pages.map((page) => ({ ...page, title: "Same title" }))
            : pages,
        ),
        ...(scenario === "no native provider"
          ? {}
          : {
              window: async () =>
                scenario === "no native window" ? undefined : windowFor("Same title"),
            }),
      });
      await expect(browser.navigate("http://localhost:3500/")).rejects.toThrow(NavigationError);
      expect(peer.connected).toEqual([]);
      expect(peer.sent).toEqual([]);
    },
  );

  it("keeps native inspection failure distinct from a missing browser", async () => {
    const peer = connection(() => ({}));
    const browser = new PageBrowser({
      ...peer,
      fetchImpl: fakeTargets(pages),
      window: async () => {
        throw new Error("native helper unavailable");
      },
    });
    await expect(browser.navigate("http://localhost:3500/")).rejects.toThrow(NavigationError);
    expect(peer.connected).toEqual([]);
    expect(peer.sent).toEqual([]);
  });

  it("focuses the identified page before navigation, tolerating a sole startup page's delayed native title", async () => {
    let navigated = false;
    const peer = connection((method) => {
      if (method === "Page.navigate") {
        navigated = true;
        return { loaderId: "next" };
      }
      return {
        result: {
          value: {
            url: navigated ? "http://localhost:3500/" : "about:blank",
            title: navigated ? "Local app" : "",
            ready: "complete",
            origin: navigated ? 2 : 1,
          },
        },
      };
    });
    const browser = new PageBrowser({
      ...peer,
      fetchImpl: fakeTargets([{ type: "page", title: "", url: "about:blank" }]),
      window: async () => windowFor("Chromium starting"),
      loadTimeoutMs: 20,
    });
    expect(await browser.navigate("http://localhost:3500/")).toMatchObject({ loaded: true });
    expect(peer.sent.indexOf("Page.bringToFront")).toBeLessThan(peer.sent.indexOf("Page.navigate"));
    expect(peer.sent.filter((method) => method === "Page.navigate")).toHaveLength(1);
  });

  it.each(["navigate", "read"] as const)(
    "waits for a multi-tab native title to catch up after %s without replaying input",
    async (operation) => {
      let changed = false;
      let delayedTitleChecks = 0;
      const peer = connection((method) => {
        if (method === "Page.navigate") {
          changed = true;
          return { loaderId: "new" };
        }
        if (method === "Runtime.evaluate") {
          if (operation === "read") changed = true;
          return {
            result: {
              value: {
                url: changed ? "http://localhost:3500/next" : "http://localhost:3500/",
                title: changed ? "New title" : "Visible",
                ready: "complete",
                origin: changed ? 2 : 1,
                text: "Visible content",
              },
            },
          };
        }
        return {};
      });
      const browser = new PageBrowser({
        ...peer,
        loadTimeoutMs: 20,
        fetchImpl: (input, init) =>
          fakeTargets([
            { type: "page", url: "https://background.test/", title: "Background" },
            {
              type: "page",
              url: "http://localhost:3500/",
              title: changed ? "New title" : "Visible",
            },
          ])(input, init),
        window: async () =>
          windowFor(changed && ++delayedTitleChecks >= 3 ? "New title" : "Visible"),
      });
      if (operation === "navigate") {
        expect(await browser.navigate("http://localhost:3500/next")).toMatchObject({
          loaded: true,
        });
        expect(peer.sent.filter((method) => method === "Page.navigate")).toHaveLength(1);
        expect(peer.sent.filter((method) => method === "Page.bringToFront")).toHaveLength(1);
      } else {
        expect(await browser.read(500)).toMatchObject({ text: "Visible content" });
        expect(peer.sent).not.toContain("Page.navigate");
        expect(peer.sent).not.toContain("Page.bringToFront");
      }
      expect(delayedTitleChecks).toBe(3);
      expect(peer.connected).toEqual(["ws://127.0.0.1:9222/devtools/page/t1"]);
    },
  );

  it("refuses a different tab once native title lag resolves without replaying navigation", async () => {
    let navigated = false;
    let titleChecks = 0;
    const peer = connection((method) => {
      if (method === "Page.navigate") {
        navigated = true;
        return { loaderId: "new" };
      }
      return {
        result: {
          value: {
            url: "http://localhost:3500/next",
            title: navigated ? "New title" : "Visible",
            ready: "complete",
            origin: navigated ? 2 : 1,
          },
        },
      };
    });
    const browser = new PageBrowser({
      ...peer,
      loadTimeoutMs: 20,
      fetchImpl: (input, init) =>
        fakeTargets([
          { type: "page", url: "https://background.test/", title: "Background" },
          {
            type: "page",
            url: "http://localhost:3500/",
            title: navigated ? "New title" : "Visible",
          },
        ])(input, init),
      window: async () => windowFor(navigated && ++titleChecks >= 2 ? "Background" : "Visible"),
    });
    await expect(browser.navigate("http://localhost:3500/next")).rejects.toThrow(/page changed/);
    expect(peer.sent.filter((method) => method === "Page.navigate")).toHaveLength(1);
    expect(titleChecks).toBe(2);
  });

  it("bounds an unresolved native title change and never repeats navigation", async () => {
    let navigated = false;
    let pendingChecks = 0;
    const peer = connection((method) => {
      if (method === "Page.navigate") {
        navigated = true;
        return { loaderId: "new" };
      }
      return {
        result: {
          value: {
            url: "http://localhost:3500/next",
            title: navigated ? "New title" : "Visible",
            ready: "complete",
            origin: navigated ? 2 : 1,
          },
        },
      };
    });
    const browser = new PageBrowser({
      ...peer,
      loadTimeoutMs: 20,
      fetchImpl: (input, init) =>
        fakeTargets([
          { type: "page", url: "https://background.test/", title: "Background" },
          {
            type: "page",
            url: "http://localhost:3500/",
            title: navigated ? "New title" : "Visible",
          },
        ])(input, init),
      window: async () => {
        if (navigated) pendingChecks++;
        return windowFor("Visible");
      },
    });
    await expect(browser.navigate("http://localhost:3500/next")).rejects.toThrow(/page changed/);
    expect(pendingChecks).toBe(11);
    expect(peer.sent.filter((method) => method === "Page.navigate")).toHaveLength(1);
  });

  it("refuses a tab change while the debugger connection opens before reading or navigating", async () => {
    const peer = connection(() => ({}));
    const window = vi
      .fn()
      .mockResolvedValueOnce(windowFor("Visible"))
      .mockResolvedValue(windowFor("Background"));
    const browser = new PageBrowser({ ...peer, fetchImpl: fakeTargets(pages), window });
    await expect(browser.navigate("http://localhost:3500/")).rejects.toThrow(/page changed/);
    expect(peer.connected).toEqual(["ws://127.0.0.1:9222/devtools/page/t1"]);
    expect(peer.sent).toEqual([]);
  });

  it("does not return background page data after a native window change during a read", async () => {
    let changed = false;
    const peer = connection((method) => {
      if (method === "Runtime.evaluate") {
        changed = true;
        return { result: { value: { ...pages[1], text: "Old visible page" } } };
      }
      return {};
    });
    const browser = new PageBrowser({
      ...peer,
      fetchImpl: fakeTargets(pages),
      window: async () => windowFor("Visible", changed ? 2 : 1),
    });
    await expect(browser.read(500)).rejects.toThrow(/page changed/);
    expect(peer.sent).not.toContain("Page.bringToFront");
  });

  it("does not replay a navigation after the user selects another tab", async () => {
    let navigated = false;
    const peer = connection((method) => {
      if (method === "Page.navigate") {
        navigated = true;
        return { loaderId: "new" };
      }
      return {
        result: {
          value: {
            url: "http://localhost:3500/",
            title: "Visible",
            ready: "complete",
            origin: navigated ? 2 : 1,
          },
        },
      };
    });
    const browser = new PageBrowser({
      ...peer,
      fetchImpl: fakeTargets(pages),
      window: async () => windowFor(navigated ? "Background" : "Visible"),
      loadTimeoutMs: 20,
    });
    await expect(browser.navigate("http://localhost:3500/")).rejects.toThrow(/page changed/);
    expect(peer.sent.filter((method) => method === "Page.navigate")).toHaveLength(1);
  });

  it("waits for delayed native focus without sending focus or navigation twice", async () => {
    let focused = false;
    let focusChecks = 0;
    let navigated = false;
    const peer = connection((method) => {
      if (method === "Page.bringToFront") focused = true;
      if (method === "Page.navigate") {
        navigated = true;
        return { loaderId: "new" };
      }
      return {
        result: {
          value: {
            url: navigated ? "http://localhost:3500/" : "about:blank",
            title: "",
            ready: "complete",
            origin: navigated ? 2 : 1,
          },
        },
      };
    });
    const browser = new PageBrowser({
      ...peer,
      loadTimeoutMs: 20,
      fetchImpl: fakeTargets([{ type: "page", url: "about:blank" }]),
      window: async () => ({ ...windowFor(""), active: focused && ++focusChecks >= 2 }),
    });
    expect(await browser.navigate("http://localhost:3500/")).toMatchObject({ loaded: true });
    expect(peer.sent.filter((method) => method === "Page.bringToFront")).toHaveLength(1);
    expect(peer.sent.filter((method) => method === "Page.navigate")).toHaveLength(1);
  });

  it("does not navigate when the native window never acknowledged focus", async () => {
    const peer = connection(() => ({
      result: { value: { url: "about:blank", title: "", ready: "complete", origin: 1 } },
    }));
    const browser = new PageBrowser({
      ...peer,
      fetchImpl: fakeTargets([{ type: "page", url: "about:blank" }]),
      window: async () => ({ ...windowFor(""), active: false }),
    });
    await expect(browser.navigate("http://localhost:3500/")).rejects.toThrow(
      /did not receive focus/,
    );
    expect(peer.sent).toContain("Page.bringToFront");
    expect(peer.sent).not.toContain("Page.navigate");
  });

  it("honors cancellation after focusing and does not dispatch navigation", async () => {
    const abort = new AbortController();
    const peer = connection((method) => {
      if (method === "Page.bringToFront") abort.abort(new Error("control taken"));
      return { result: { value: { url: "about:blank", title: "", ready: "complete", origin: 1 } } };
    });
    const browser = new PageBrowser({
      ...peer,
      fetchImpl: fakeTargets([{ type: "page", url: "about:blank" }]),
      window: async () => windowFor(""),
    });
    await expect(browser.navigate("http://localhost:3500/", abort.signal)).rejects.toThrow(
      "control taken",
    );
    expect(peer.sent).not.toContain("Page.navigate");
  });
});
