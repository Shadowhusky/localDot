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
