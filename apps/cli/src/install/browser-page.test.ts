import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { PROGRESS_SCRIPT } from "./browser-page.ts";

afterEach(() => vi.useRealTimers());
function page(state: unknown, hash = `#progress=${"a".repeat(43)}`) {
  vi.useFakeTimers();
  const nodes: Record<string, { textContent: string }> = {
    "#title": { textContent: "" },
    "#detail": { textContent: "" },
    "#badge": { textContent: "" },
  };
  const replace = vi.fn(),
    history = vi.fn(),
    events: Record<string, () => void> = {};
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => state });
  runInNewContext(PROGRESS_SCRIPT, {
    location: { hash, replace },
    history: { replaceState: history },
    document: { querySelector: (selector: string) => nodes[selector] },
    addEventListener: (name: string, handler: () => void) => {
      events[name] = handler;
    },
    fetch,
    setTimeout,
    clearTimeout,
    AbortController,
    URL,
  });
  return { nodes, replace, history, fetch, events };
}
it("removes the capability from history before polling with bounded same-origin fetch", async () => {
  const p = page({
    phase: "images",
    role: "desktop",
    imagePhase: "downloading",
    currentBytes: 5,
    totalBytes: 10,
  });
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
  expect(p.nodes["#detail"]?.textContent).toBe("Downloading Desktop… 50% of this layer");
  p.events.pagehide?.();
  await vi.advanceTimersByTimeAsync(750);
  expect(p.fetch).toHaveBeenCalledOnce();
});
it("does not poll when a page is reopened without its capability", async () => {
  const p = page({}, "");
  await vi.advanceTimersByTimeAsync(0);
  expect(p.fetch).not.toHaveBeenCalled();
  expect(p.nodes["#title"]?.textContent).toBe("Return to your terminal");
});
it("navigates using only the successful local one-use URL", async () => {
  const url = `http://127.0.0.1:4750/#code=${"b".repeat(43)}`;
  const p = page({ phase: "ready", url });
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
  const p = page({ phase: "ready", url });
  await vi.advanceTimersByTimeAsync(0);
  expect(p.replace).not.toHaveBeenCalled();
  expect(p.nodes["#title"]?.textContent).toBe("Return to your terminal");
});
it("shows fixed failure instructions without displaying server error strings", async () => {
  const p = page({ phase: "failed", error: "private secret <script>" });
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.stringify(p.nodes)).not.toContain("private secret");
  expect(p.nodes["#title"]?.textContent).toBe("Setup needs attention");
  expect(vi.getTimerCount()).toBe(0);
});
