import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogStore } from "./catalog-store.ts";

const owned: string[] = [];
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "localdot-catalog-boundary-"));
  owned.push(h);
  return h;
};
afterEach(() => {
  vi.useRealTimers();
  for (const h of owned.splice(0)) rmSync(h, { recursive: true, force: true });
});
const raw = {
  openai: {
    models: {
      one: {
        id: "one",
        tool_call: true,
        cost: { input: 1, output: 2 },
        limit: { context: 8192, output: 2048 },
      },
    },
  },
};
const response = () => new Response(JSON.stringify(raw));

describe("public catalog cache boundaries", () => {
  it("does no fetch on construction/get and returns an immutable cache snapshot", async () => {
    const h = home(),
      fetchImpl = vi.fn<typeof fetch>(async () => response());
    const store = new CatalogStore(h, { fetchImpl });
    expect(store.get()).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    const cached = await store.refresh();
    expect(Object.isFrozen(cached.providers.openai?.models.one)).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: { accept: "application/json" },
      redirect: "error",
    });
    new CatalogStore(h, { fetchImpl }).get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("enforces actual streamed bytes despite a misleading Content-Length and retains the last good cache", async () => {
    const h = home();
    let good = true,
      cancelled = false;
    const payload = Buffer.from(JSON.stringify({ ...raw, padding: "x".repeat(5000) }));
    const parts = [payload.subarray(0, 3000), payload.subarray(3000)];
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      good
        ? response()
        : new Response(
            new ReadableStream(
              {
                pull(c) {
                  const part = parts.shift();
                  if (part) c.enqueue(part);
                  else c.close();
                },
                cancel() {
                  cancelled = true;
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-length": "1" } },
          ),
    );
    const store = new CatalogStore(h, { fetchImpl, maxBytes: 4096 });
    const before = await store.refresh();
    const disk = readFileSync(join(h, "catalog/models.json"), "utf8");
    good = false;
    await expect(store.refresh()).rejects.toThrow(/too large/);
    expect(cancelled).toBe(true);
    expect(store.get()).toBe(before);
    expect(readFileSync(join(h, "catalog/models.json"), "utf8")).toBe(disk);
    expect(readdirSync(join(h, "catalog"))).toEqual(["models.json"]);
  });
  it("cancels a stalled body at the deadline and resets single-flight state", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const h = home();
    let stalled = true;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      stalled
        ? new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(Buffer.from("{"));
              },
              cancel() {
                cancelled = true;
              },
            }),
          )
        : response(),
    );
    const store = new CatalogStore(h, { fetchImpl, timeoutMs: 100 });
    const pending = store.refresh();
    expect(store.refresh()).toBe(pending);
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(cancelled).toBe(true);
    expect(store.get()).toBeUndefined();
    stalled = false;
    await store.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("does not write a late response when a fetch implementation ignores its deadline", async () => {
    vi.useFakeTimers();
    let answer!: (r: Response) => void;
    let cancelled = false;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const h = home();
    const store = new CatalogStore(h, { fetchImpl, timeoutMs: 100 });
    const pending = store.refresh();
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    answer(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(Buffer.from(JSON.stringify(raw)));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(true);
    expect(store.get()).toBeUndefined();
    expect(readdirSync(join(h, "catalog"))).toEqual([]);
  });
  it("refuses redirected/invalid source configuration and linked cache files", async () => {
    expect(() => new CatalogStore(home(), { source: "file:///etc/passwd" })).toThrow(/source/);
    expect(
      () => new CatalogStore(home(), { source: "https://user:password@example.com/" }),
    ).toThrow(/source/);
    const h = home(),
      outside = home();
    writeFileSync(join(outside, "sentinel"), "keep");
    const store = new CatalogStore(h, { fetchImpl: async () => response() });
    symlinkSync(join(outside, "sentinel"), join(h, "catalog/models.json"));
    expect(store.get()).toBeUndefined();
    await expect(store.refresh()).rejects.toThrow(/regular/);
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("keep");
  });
});
