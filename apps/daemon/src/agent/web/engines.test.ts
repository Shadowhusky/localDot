import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bing,
  bingImages,
  bingNews,
  commonsImages,
  duckDuckGo,
  ENGINES,
  SearchBlocked,
  searchAddresses,
  thumbnailUrl,
  yahooNews,
} from "./engines.ts";

// Saved from each engine for "Zelda Breath of the Wild" in October 2026, scripts and styles taken
// out; the challenge page is written by hand after the real one.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("keyless search result pages", () => {
  it("reads the page without scripts: results through the redirect, never its ads", () => {
    const hits = duckDuckGo.read(fixture("duckduckgo-web.html"));
    expect(hits).toHaveLength(10);
    expect(hits[0]).toEqual({
      title: "The Legend of Zelda: Breath of the Wild - Wikipedia",
      url: "https://en.wikipedia.org/wiki/The_Legend_of_Zelda:_Breath_of_the_Wild",
      site: "en.wikipedia.org",
      snippet: expect.stringContaining("is a 2017 action-adventure game developed by Nintendo EPD"),
    });
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https:\/\//);
      expect(hit.url).not.toMatch(/duckduckgo\.com|bing\.com\/aclick|amazon\./);
      expect(hit.title.length).toBeGreaterThan(5);
    }
  });

  it("decodes the other engine's click-through links", () => {
    const hits = bing.read(fixture("bing-web.html"));
    expect(hits).toHaveLength(10);
    expect(hits.map((hit) => hit.site)).toContain("zelda.fandom.com");
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https?:\/\//);
      expect(new URL(hit.url).hostname).not.toMatch(/bing\.com$/);
      expect(hit.snippet).toBeTruthy();
    }
    expect(hits.find((hit) => hit.site === "zeldadungeon.net")).toMatchObject({
      title: "Breath of the Wild Walkthrough - The Legend of Zelda Guide",
      url: "https://www.zeldadungeon.net/breath-of-the-wild-walkthrough/",
    });
  });

  it("reads image results with their page, the picture and the engine's small copy", () => {
    const hits = bingImages.read(fixture("bing-images.html"));
    expect(hits).toHaveLength(12);
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https?:\/\//);
      expect(hit.image).toMatch(/^https?:\/\//);
      expect(thumbnailUrl(hit.thumbnail)?.hostname).toMatch(/\.mm\.bing\.net$|^th\.bing\.com$/);
    }
    expect(hits[0]?.title).toBeTruthy();
  });

  it("reads open-licence pictures from the Commons API, leaving out what is not a picture", () => {
    const hits = commonsImages.read(fixture("commons-images.json"));
    expect(hits.length).toBeGreaterThan(4);
    expect(hits[0]).toMatchObject({
      title: "The Legend of Zelda Breath of the Wild",
      url: "https://commons.wikimedia.org/wiki/File:The_Legend_of_Zelda_Breath_of_the_Wild.svg",
      site: "commons.wikimedia.org",
    });
    for (const hit of hits) expect(thumbnailUrl(hit.thumbnail)).toBeDefined();
    expect(commonsImages.read("{}")).toEqual([]);
  });

  it("reads news with who published it and when", () => {
    const bingHits = bingNews.read(fixture("bing-news.html"));
    expect(bingHits).toHaveLength(12);
    expect(bingHits[0]).toMatchObject({
      title:
        "The Legend of Zelda: Breath of the Wild is now playable in 4K on PlayStation 5 consoles",
      site: "tweaktown.com",
      source: "TweakTown",
      age: "2 days ago",
    });
    const yahooHits = yahooNews.read(fixture("yahoo-news.html"));
    expect(yahooHits).toHaveLength(10);
    for (const hit of yahooHits) {
      expect(new URL(hit.url).hostname).not.toMatch(/yahoo\.com$/);
      expect(hit.source).toBeTruthy();
    }
  });

  it("tells a check for robots from a page with no results", () => {
    expect(() => duckDuckGo.read(fixture("duckduckgo-challenge.html"))).toThrow(SearchBlocked);
    for (const engine of [duckDuckGo, bing, bingImages, bingNews, yahooNews])
      expect(() => engine.read(fixture("captcha.html"))).toThrow(SearchBlocked);
    expect(() => commonsImages.read('{"challenge":{},"response_type":"botnet_challenge"}')).toThrow(
      SearchBlocked,
    );
    const empty = "<html><head><title>nothing at all</title></head><body><p>No results.</p>";
    expect(duckDuckGo.read(empty)).toEqual([]);
    expect(bing.read("")).toEqual([]);
  });

  it("puts the query in each engine's address, which is where a search sends it", () => {
    expect(searchAddresses("zelda & link", "web").map(String)).toEqual([
      "https://html.duckduckgo.com/html/?q=zelda+%26+link",
      "https://www.bing.com/search?q=zelda+%26+link",
    ]);
    expect(searchAddresses("zelda").map((url) => url.hostname)).toEqual(
      ENGINES.web.map((engine) => engine.host),
    );
    expect(searchAddresses("zelda", "images").map((url) => url.hostname)).toEqual([
      "www.bing.com",
      "commons.wikimedia.org",
    ]);
    expect(searchAddresses("zelda", "images")[1]?.searchParams.get("gsrsearch")).toBe("zelda");
    expect(searchAddresses("zelda", "news").map((url) => url.hostname)).toEqual([
      "www.bing.com",
      "news.search.yahoo.com",
    ]);
  });

  it("fetches pictures only from the engines' own copies, over https", () => {
    expect(thumbnailUrl("https://ts2.mm.bing.net/th?id=OIP.x&pid=15.1")?.hostname).toBe(
      "ts2.mm.bing.net",
    );
    expect(thumbnailUrl("https://upload.wikimedia.org/a/b.jpg")).toBeDefined();
    for (const raw of [
      "http://ts2.mm.bing.net/th?id=x",
      "https://evil.example/th?id=x",
      "https://mm.bing.net.evil.example/x",
      "https://127.0.0.1/x",
      undefined,
    ])
      expect(thumbnailUrl(raw), raw).toBeUndefined();
  });
});
