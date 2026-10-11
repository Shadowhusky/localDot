import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODELS_DEV_FIXTURE } from "@localdot/providers/testing";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogStore } from "./catalog-store.ts";

const ownedHomes: string[] = [];
afterEach(() => {
  for (const home of ownedHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function ownedTemp(prefix: string): string {
  const home = mkdtempSync(prefix);
  ownedHomes.push(home);
  return home;
}

const now = () => new Date("2026-10-02T09:00:00.000Z");

describe("CatalogStore", () => {
  it("has nothing until refreshed, then caches the normalized catalog on disk", async () => {
    const home = ownedTemp(join(tmpdir(), "local dot's catalog-"));
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(MODELS_DEV_FIXTURE));
    }) as unknown as typeof fetch;
    const store = new CatalogStore(home, { fetchImpl, now });
    expect(store.get()).toBeUndefined();
    const catalog = await store.refresh();
    expect(urls).toEqual(["https://models.dev/api.json"]);
    expect(catalog.fetchedAt).toBe("2026-10-02T09:00:00.000Z");
    const file = join(home, "catalog", "models.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(readFileSync(file, "utf8")).providers.anthropic.models["claude-sonnet-5-5"]
        .outputUSDPerMTok,
    ).toBe(10);
    expect(new CatalogStore(home, { fetchImpl, now }).get()?.fetchedAt).toBe(
      "2026-10-02T09:00:00.000Z",
    );
  });

  it("keeps the cache when a refresh fails, and runs one refresh at a time", async () => {
    const home = ownedTemp(join(tmpdir(), "local dot's catalog-"));
    let calls = 0;
    let ok = true;
    const fetchImpl = (async () => {
      calls += 1;
      return ok
        ? new Response(JSON.stringify(MODELS_DEV_FIXTURE))
        : new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;
    const store = new CatalogStore(home, { fetchImpl, now });
    await Promise.all([store.refresh(), store.refresh()]);
    expect(calls).toBe(1);
    ok = false;
    await expect(store.refresh()).rejects.toThrow(/503/);
    expect(store.get()?.providers.google).toBeDefined();
  });
});

it("does not replace a usable model cache with an empty catalog", async () => {
  const home = ownedTemp(join(tmpdir(), "ld-empty-catalog-"));
  let empty = false;
  const store = new CatalogStore(home, {
    fetchImpl: async () => Response.json(empty ? {} : MODELS_DEV_FIXTURE),
  });
  await store.refresh();
  empty = true;
  await expect(store.refresh()).rejects.toThrow("no usable models");
  expect(store.get()?.providers.deepseek).toBeDefined();
});

it("serves cached models immediately, refreshes stale data once, and backs off offline", async () => {
  const home = ownedTemp(join(tmpdir(), "ld-fresh-catalog-"));
  let time = Date.parse("2026-10-11T10:00:00Z");
  let calls = 0;
  let release: (() => void) | undefined;
  let fail = false;
  const store = new CatalogStore(home, {
    now: () => new Date(time),
    fetchImpl: async () => {
      calls++;
      if (calls > 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (fail) throw new Error("offline");
      return Response.json(MODELS_DEV_FIXTURE);
    },
  });
  const first = await store.fresh();
  expect(calls).toBe(1);
  expect(store.freshness()).toEqual({ stale: false, refreshing: false, refreshFailed: false });
  await store.fresh();
  expect(calls).toBe(1);
  time += 300_001;
  expect(await store.fresh()).toBe(first);
  expect(store.freshness().refreshing).toBe(true);
  await store.fresh();
  expect(calls).toBe(2);
  const shared = store.refresh();
  release?.();
  await shared;
  expect(store.get()?.fetchedAt).not.toBe(first?.fetchedAt);
  time += 300_001;
  fail = true;
  await store.fresh();
  const failed = store.refresh();
  release?.();
  await expect(failed).rejects.toThrow("offline");
  expect(store.freshness()).toEqual({ stale: true, refreshing: false, refreshFailed: true });
  await store.fresh();
  expect(calls).toBe(3);
  time += 60_001;
  await store.fresh();
  expect(calls).toBe(4);
  const last = store.refresh();
  release?.();
  await expect(last).rejects.toThrow("offline");
});

it("refreshes a stale disk cache after restarting and keeps it if the download fails", async () => {
  const home = ownedTemp(join(tmpdir(), "ld-disk-catalog-"));
  const original = new CatalogStore(home, {
    now,
    fetchImpl: async () => Response.json(MODELS_DEV_FIXTURE),
  });
  await original.refresh();
  const restarted = new CatalogStore(home, {
    now: () => new Date("2026-10-12"),
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  expect((await restarted.fresh())?.providers.deepseek).toBeDefined();
  await expect(restarted.refresh()).rejects.toThrow("offline");
  expect(restarted.get()?.fetchedAt).toBe(now().toISOString());
});
