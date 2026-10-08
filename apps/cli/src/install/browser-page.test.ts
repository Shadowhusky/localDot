import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { BRAND_TOKENS } from "../../../../packages/protocol/src/brand-tokens.ts";
import { PROGRESS_HTML, PROGRESS_SCRIPT, PROGRESS_STYLE } from "./browser-page.ts";

interface FakeNode {
  textContent: string;
  hidden: boolean;
  dataset: Record<string, string>;
  style: Record<string, string>;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(name: string, handler: () => void): void;
}

afterEach(() => vi.useRealTimers());
function page(states: unknown[], hash = `#progress=${"a".repeat(43)}`) {
  vi.useFakeTimers();
  const nodes: Record<string, FakeNode> = {};
  const node = (selector: string): FakeNode =>
    (nodes[selector] ??= {
      textContent: "",
      hidden: selector === "#resume",
      // As the served page starts: checking the release.
      dataset: selector === "#release" ? { state: "doing" } : {},
      style: {},
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      addEventListener() {},
    });
  const replace = vi.fn(),
    history = vi.fn(),
    events: Record<string, () => void> = {};
  const replies = [...states];
  const fetch = vi.fn().mockImplementation(async () => {
    const state = replies.length > 1 ? replies.shift() : replies[0];
    return { ok: true, json: async () => state };
  });
  runInNewContext(PROGRESS_SCRIPT, {
    location: { hash, replace },
    history: { replaceState: history },
    document: { querySelector: node },
    navigator: {},
    addEventListener: (name: string, handler: () => void) => {
      events[name] = handler;
    },
    fetch,
    setTimeout,
    clearTimeout,
    AbortController,
    URL,
  });
  return { node, replace, history, fetch, events };
}
it("removes the capability from history before polling with bounded same-origin fetch", async () => {
  const p = page([{ phase: "images", role: "desktop", imagePhase: "downloading", progress: 0.5 }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(p.history).toHaveBeenCalledWith(null, "", "/");
  expect(p.history.mock.invocationCallOrder[0]).toBeLessThan(
    p.fetch.mock.invocationCallOrder[0] ?? 0,
  );
  expect(p.fetch).toHaveBeenCalledWith(
    "/status",
    expect.objectContaining({
      headers: { Authorization: `Bearer ${"a".repeat(43)}` },
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    }),
  );
  expect(p.node("#detail").textContent).toBe("Downloading the desktop image…");
  expect(p.node("#images-value").textContent).toBe("50%");
  expect(p.node("#fill").style.transform).toBe("scaleX(0.5)");
  expect(p.node("#release").dataset.state).toBe("done");
  expect(p.node("#release-label").textContent).toBe("Release verified");
  expect(p.node("#images").dataset.state).toBe("doing");
  p.events.pagehide?.();
  await vi.advanceTimersByTimeAsync(750);
  expect(p.fetch).toHaveBeenCalledOnce();
});
it("fills one bar over all the images and never moves it back", async () => {
  const images = (progress: number) => ({
    phase: "images",
    role: "gate",
    imagePhase: "downloading",
    progress,
  });
  const p = page([images(0.62), images(0.4), { phase: "starting" }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(p.node("#images-value").textContent).toBe("62%");
  await vi.advanceTimersByTimeAsync(750);
  expect(p.node("#images-value").textContent).toBe("62%");
  expect(p.node("#fill").style.transform).toBe("scaleX(0.62)");
  expect(p.node("#bar").attributes["aria-valuenow"]).toBe("62");
  await vi.advanceTimersByTimeAsync(750);
  expect(p.node("#title").textContent).toBe("Starting localDot");
  expect(p.node("#images").dataset.state).toBe("done");
  expect(p.node("#startup").dataset.state).toBe("doing");
});
it("does not poll when a page is reopened without its capability", async () => {
  const p = page([{}], "");
  await vi.advanceTimersByTimeAsync(0);
  expect(p.fetch).not.toHaveBeenCalled();
  expect(p.node("#title").textContent).toBe("Return to your terminal");
  expect(p.node("#resume").hidden).toBe(false);
});
it("navigates using only the successful local one-use URL", async () => {
  const url = `http://127.0.0.1:4750/#code=${"b".repeat(43)}`;
  const p = page([{ phase: "ready", url }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(p.replace).toHaveBeenCalledWith(url);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  "https://evil.example/",
  "javascript:alert(1)",
  `http://127.0.0.1:80/#code=${"b".repeat(43)}`,
  `http://127.0.0.1:65536/#code=${"b".repeat(43)}`,
])("refuses an invalid navigation response %s", async (url) => {
  const p = page([{ phase: "ready", url }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(p.replace).not.toHaveBeenCalled();
  expect(p.node("#title").textContent).toBe("Return to your terminal");
});
it("shows fixed failure instructions without displaying server error strings", async () => {
  const p = page([{ phase: "failed", error: "private secret <script>" }]);
  await vi.advanceTimersByTimeAsync(0);
  for (const selector of ["#title", "#detail", "#images-value", "#release-label"])
    expect(p.node(selector).textContent).not.toContain("private secret");
  expect(p.node("#title").textContent).toBe("Setup stopped");
  expect(p.node("#detail").textContent).toBe("Run localdot again. It picks up where it left off.");
  expect(p.node("#resume").hidden).toBe(false);
  expect(p.node("#release").dataset.state).toBe("failed");
  expect(vi.getTimerCount()).toBe(0);
});
it("draws the page in the app's own colours and type", () => {
  for (const [name, value] of Object.entries(BRAND_TOKENS))
    expect(PROGRESS_STYLE).toContain(`--${name}:${value}`);
  expect(PROGRESS_STYLE.replace(/--[\w-]+:[^;]+;/g, "")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  expect(PROGRESS_HTML.replace(PROGRESS_SCRIPT, "")).not.toMatch(/style=|<link|https?:/);
});
