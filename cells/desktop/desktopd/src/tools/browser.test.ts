import { describe, expect, it } from "vitest";
import { fakeCdp, fakeTargets } from "../testing/fake-cdp.ts";
import { NavigationError, NoPageError, outlineOf, PageBrowser } from "./browser.ts";

describe("PageBrowser", () => {
  it("reads the sole page's text and outline, cut at maxChars", async () => {
    const { WebSocketImpl } = fakeCdp((method) => {
      if (method === "Runtime.evaluate")
        return {
          result: {
            value: {
              url: "https://example.com/",
              title: "Example",
              text: "Hello world, this is long",
            },
          },
        };
      if (method === "Accessibility.getFullAXTree")
        return {
          nodes: [
            { role: { value: "heading" }, name: { value: "Example Domain" } },
            { role: { value: "generic" }, name: { value: "x" } },
            { role: { value: "link" }, name: { value: "More" } },
          ],
        };
      return {};
    });
    const browser = new PageBrowser({
      WebSocketImpl,
      fetchImpl: fakeTargets([{ type: "page", url: "https://example.com/" }]),
    });
    expect(await browser.read(11)).toEqual({
      url: "https://example.com/",
      title: "Example",
      text: "Hello world",
      outline: 'heading "Example Domain"\nlink "More"',
      truncated: true,
    });
  });

  it("reads only the front page's address, running nothing in the page", async () => {
    const { WebSocketImpl, sent } = fakeCdp(() => ({}));
    const browser = new PageBrowser({
      WebSocketImpl,
      fetchImpl: fakeTargets([{ type: "page", url: "https://accounts.google.com/signin" }]),
    });
    expect(await browser.page()).toEqual({ url: "https://accounts.google.com/signin" });
    expect(sent).toEqual([]);
  });

  it("says there is no page when Chromium has none or is not running", async () => {
    const { WebSocketImpl } = fakeCdp(() => ({}));
    await expect(
      new PageBrowser({
        WebSocketImpl,
        fetchImpl: fakeTargets([{ type: "page", url: "devtools://x" }]),
      }).read(100),
    ).rejects.toThrow(NoPageError);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new PageBrowser({ WebSocketImpl, fetchImpl: down }).read(100)).rejects.toThrow(
      NoPageError,
    );
  });

  it("navigates and waits for the new document, not the old one's complete state", async () => {
    let navigated = false;
    let polls = 0;
    const { WebSocketImpl, sent } = fakeCdp((method) => {
      if (method === "Page.navigate") {
        navigated = true;
        return { frameId: "f" };
      }
      if (method === "Runtime.evaluate") {
        if (!navigated)
          return {
            result: { value: { url: "about:blank", title: "", ready: "complete", origin: 1 } },
          };
        polls += 1;
        return {
          result: {
            value:
              polls < 2
                ? { url: "about:blank", title: "", ready: "complete", origin: 1 }
                : { url: "https://example.com/", title: "Example", ready: "complete", origin: 2 },
          },
        };
      }
      return {};
    });
    const browser = new PageBrowser({
      WebSocketImpl,
      fetchImpl: fakeTargets([{ type: "page", url: "about:blank" }]),
    });
    expect(await browser.navigate("https://example.com/")).toEqual({
      url: "https://example.com/",
      title: "Example",
      loaded: true,
    });
    expect(sent).toContain("Page.navigate");
    expect(polls).toBe(2);
  });

  it("classifies a CDP timeout without exposing its raw transport error", async () => {
    const { WebSocketImpl } = fakeCdp((method) => {
      if (method === "Page.navigate") throw new Error("Page.navigate timed out");
      return { result: { value: { url: "about:blank", title: "", ready: "complete", origin: 1 } } };
    });
    const browser = new PageBrowser({
      WebSocketImpl,
      fetchImpl: fakeTargets([{ type: "page", url: "about:blank" }]),
    });
    await expect(browser.navigate("https://app.localhost:1355/")).rejects.toThrow(
      "navigation failed: page operation timed out",
    );
  });

  it("reports a navigation Chromium refused", async () => {
    const { WebSocketImpl } = fakeCdp((method) =>
      method === "Page.navigate"
        ? { errorText: "net::ERR_NAME_NOT_RESOLVED" }
        : { result: { value: { url: "", title: "", ready: "complete", origin: 1 } } },
    );
    const browser = new PageBrowser({
      WebSocketImpl,
      fetchImpl: fakeTargets([{ type: "page", url: "about:blank" }]),
    });
    await expect(browser.navigate("https://nope.invalid/")).rejects.toThrow(NavigationError);
  });

  it("outlines only named, meaningful roles and caps the length", () => {
    const nodes = Array.from({ length: 500 }, (_, i) => ({
      role: { value: "link" },
      name: { value: `L${i}` },
    }));
    expect(outlineOf(nodes).split("\n")).toHaveLength(400);
    expect(
      outlineOf([{ ignored: true, role: { value: "button" }, name: { value: "Hidden" } }]),
    ).toBe("");
  });
});
