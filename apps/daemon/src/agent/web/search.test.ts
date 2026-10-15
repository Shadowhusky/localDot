import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { WebAccess, WebGet, WebReply } from "./cell.ts";
import { WebError } from "./cell.ts";
import { webFetch } from "./fetch.ts";
import { webSearch } from "./search.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const signal = new AbortController().signal;

type Answer = Partial<WebReply> | Error;
// The web as a table of answers by host, or by whole address; anything else fails to connect.
function fakeWeb(answers: Record<string, Answer | ((url: URL) => Answer)>) {
  const asked: { url: string; options: WebGet }[] = [];
  const web: WebAccess = {
    get: async (url, options) => {
      asked.push({ url: url.href, options });
      const entry = answers[url.href] ?? answers[url.hostname];
      const answer = typeof entry === "function" ? entry(url) : entry;
      if (!answer || answer instanceof Error) throw answer ?? new TypeError("fetch failed");
      return {
        url,
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: Buffer.alloc(0),
        truncated: false,
        ...answer,
      };
    },
  };
  return { web, asked };
}

const page = (name: string, contentType = "text/html; charset=utf-8") => ({
  body: fixture(name),
  contentType,
});
const canvas = () =>
  sharp({
    create: {
      width: 900,
      height: 600,
      channels: 4,
      background: { r: 200, g: 40, b: 40, alpha: 1 },
    },
  });
const png = await canvas().png().toBuffer();
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>');
const tiff = await canvas().tiff().toBuffer();
const heif = await canvas().avif().toBuffer();

describe("web search", () => {
  it("returns the first engine's results, as many as asked for", async () => {
    const { web, asked } = fakeWeb({ "html.duckduckgo.com": page("duckduckgo-web.html") });
    const out = await webSearch(web, { query: "Zelda Breath of the Wild", count: 3 }, signal);
    expect(out.hits.map((hit) => hit.site)).toEqual([
      "en.wikipedia.org",
      "zeldadungeon.net",
      "ign.com",
    ]);
    expect(out.problems).toEqual([]);
    expect(out.pictures).toEqual([]);
    expect(asked.map((a) => a.url)).toEqual([
      "https://html.duckduckgo.com/html/?q=Zelda+Breath+of+the+Wild",
    ]);
  });

  it("falls back to the next engine when one shows a check for robots or fails", async () => {
    const blocked = fakeWeb({
      "html.duckduckgo.com": page("duckduckgo-challenge.html"),
      "www.bing.com": page("bing-web.html"),
    });
    const out = await webSearch(blocked.web, { query: "Zelda" }, signal);
    expect(out.hits).toHaveLength(8);
    expect(out.problems).toEqual(["html.duckduckgo.com showed a check for robots (a CAPTCHA)"]);
    const refused = fakeWeb({
      "html.duckduckgo.com": { status: 202, body: Buffer.from("") },
      "www.bing.com": new WebError("The site did not answer in time."),
    });
    const none = await webSearch(refused.web, { query: "Zelda" }, signal);
    expect(none.hits).toEqual([]);
    expect(none.problems).toEqual([
      "html.duckduckgo.com answered 202",
      "www.bing.com The site did not answer in time.",
    ]);
  });

  it("fills in from the next engine when the first has too few, without repeating a page", async () => {
    const { web } = fakeWeb({
      "html.duckduckgo.com": page("duckduckgo-web.html"),
      "www.bing.com": page("bing-web.html"),
    });
    const out = await webSearch(web, { query: "Zelda", count: 20 }, signal);
    expect(out.hits.length).toBeGreaterThan(10);
    expect(out.hits.length).toBeLessThanOrEqual(20);
    const urls = out.hits.map((hit) => hit.url.replace(/\/$/, ""));
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("shows the first pictures of an image search, small, from the engine's own copies only", async () => {
    const { web, asked } = fakeWeb({
      "www.bing.com": page("bing-images.html"),
      "ts1.mm.bing.net": { body: png, contentType: "image/png" },
      "ts2.mm.bing.net": { body: png, contentType: "image/png" },
      "ts3.mm.bing.net": { body: png, contentType: "image/png" },
      "ts4.mm.bing.net": new TypeError("fetch failed"),
    });
    const out = await webSearch(web, { query: "Zelda", kind: "images", count: 10 }, signal);
    expect(out.hits).toHaveLength(10);
    expect(out.pictures.length).toBeGreaterThan(0);
    expect(out.pictures.length).toBeLessThanOrEqual(4);
    for (const picture of out.pictures) {
      const meta = await sharp(picture.data).metadata();
      expect(meta.format).toBe("jpeg");
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(512);
      expect(out.hits[picture.n - 1]?.thumbnail).toBe(picture.url);
    }
    const hosts = asked.slice(1).map((a) => new URL(a.url).hostname);
    for (const host of hosts) expect(host).toMatch(/\.mm\.bing\.net$|^th\.bing\.com$/);
    expect(hosts.length).toBeLessThanOrEqual(6);
  });

  it("asks only for WebP, PNG and JPEG thumbnails, and shows no SVG, TIFF or HEIF served as one", async () => {
    const { web, asked } = fakeWeb({
      "www.bing.com": page("bing-images.html"),
      "ts1.mm.bing.net": { body: svg, contentType: "image/svg+xml" },
      "ts2.mm.bing.net": { body: tiff, contentType: "image/png" },
      "ts3.mm.bing.net": { body: heif, contentType: "image/avif" },
      "ts4.mm.bing.net": { body: png, contentType: "image/png" },
    });
    const out = await webSearch(web, { query: "Zelda", kind: "images", count: 10 }, signal);
    const thumbnails = asked.slice(1);
    expect(thumbnails.length).toBeGreaterThan(0);
    for (const { options } of thumbnails)
      expect(options.accept).toBe("image/webp,image/png,image/jpeg");
    const shown = out.pictures.map((picture) => new URL(picture.url).hostname);
    expect(shown.length).toBeGreaterThan(0);
    for (const host of shown) expect(host).toBe("ts4.mm.bing.net");
  });
});

describe("reading a page or a picture", () => {
  it("reads a page as Markdown and a picture as a small JPEG", async () => {
    const { web } = fakeWeb({
      "en.wikipedia.org": page("article.html"),
      "upload.wikimedia.org": { body: png, contentType: "image/png" },
    });
    const article = await webFetch(
      web,
      new URL("https://en.wikipedia.org/wiki/The_Legend_of_Zelda:_Breath_of_the_Wild"),
      5000,
      signal,
    );
    expect(article).toMatchObject({
      kind: "page",
      title: "The Legend of Zelda: Breath of the Wild - Wikipedia",
      truncated: true,
    });
    const picture = await webFetch(
      web,
      new URL("https://upload.wikimedia.org/z.png"),
      5000,
      signal,
    );
    expect(picture).toMatchObject({ kind: "image", width: 900, height: 600 });
  });

  it("says what it can't read: errors, PDFs, checks for robots and other files", async () => {
    const { web } = fakeWeb({
      "a.example.org": { status: 404 },
      "b.example.org": { contentType: "application/pdf" },
      "c.example.org": page("captcha.html"),
      "d.example.org": { contentType: "application/zip", body: Buffer.from("PK") },
      "e.example.org": { contentType: "image/png", body: Buffer.from("not a picture") },
      "f.example.org": { contentType: "application/json", body: Buffer.from('{"a":1}') },
    });
    const read = (host: string) => webFetch(web, new URL(`https://${host}/x`), 5000, signal);
    await expect(read("a.example.org")).rejects.toThrow("The site answered 404.");
    await expect(read("b.example.org")).rejects.toThrow("research op pdf");
    await expect(read("c.example.org")).rejects.toThrow("check for robots");
    await expect(read("d.example.org")).rejects.toThrow("application/zip");
    await expect(read("e.example.org")).rejects.toThrow("The picture could not be read.");
    await expect(read("f.example.org")).resolves.toMatchObject({ kind: "page", text: '{"a":1}' });
  });

  it("refuses SVG, TIFF and HEIF served as image/*", async () => {
    const { web } = fakeWeb({
      "a.example.org": { body: svg, contentType: "image/svg+xml" },
      "b.example.org": { body: svg, contentType: "image/png" },
      "c.example.org": { body: tiff, contentType: "image/tiff" },
      "d.example.org": { body: heif, contentType: "image/avif" },
    });
    for (const host of ["a.example.org", "b.example.org", "c.example.org", "d.example.org"])
      await expect(webFetch(web, new URL(`https://${host}/x`), 5000, signal), host).rejects.toThrow(
        "The picture could not be read.",
      );
  });
});
