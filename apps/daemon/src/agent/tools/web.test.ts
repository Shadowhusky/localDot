import { readFileSync } from "node:fs";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchLog } from "../research.ts";
import { toolRisk } from "../safety/authorize.ts";
import { toolHarness } from "../testing/harness.ts";
import { type WebAccess, WebError, type WebReply } from "../web/cell.ts";

const fixture = (name: string) => readFileSync(new URL(`../web/fixtures/${name}`, import.meta.url));
const png = await sharp({
  create: { width: 640, height: 480, channels: 3, background: { r: 10, g: 120, b: 60 } },
})
  .png()
  .toBuffer();

// Pages by host; anything else fails to connect.
function fakeWeb(pages: Record<string, Partial<WebReply>>) {
  const asked: string[] = [];
  const web: WebAccess = {
    get: async (url) => {
      asked.push(url.href);
      const page = pages[url.hostname];
      if (!page) throw new TypeError("fetch failed");
      return {
        url,
        status: 200,
        contentType: "text/html",
        body: Buffer.alloc(0),
        truncated: false,
        ...page,
      };
    },
  };
  return { web, asked };
}
const WEB = {
  "html.duckduckgo.com": { body: fixture("duckduckgo-web.html") },
  "www.bing.com": { body: fixture("bing-images.html") },
  "ts1.mm.bing.net": { body: png, contentType: "image/png" },
  "ts2.mm.bing.net": { body: png, contentType: "image/png" },
  "ts3.mm.bing.net": { body: png, contentType: "image/png" },
  "ts4.mm.bing.net": { body: png, contentType: "image/png" },
  "en.wikipedia.org": { body: fixture("article.html") },
  "upload.wikimedia.org": { body: png, contentType: "image/png" },
};

const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const h of fixtures.splice(0)) h.close();
});
function harness(pages: Record<string, Partial<WebReply>> = WEB) {
  const { web, asked } = fakeWeb(pages);
  const h = toolHarness({ web });
  fixtures.push(h);
  return { ...h, asked };
}
const textOf = (res: { body: { content: { text?: string }[] } }) =>
  res.body.content.map((c) => c.text ?? "").join("\n");
const ARTICLE = "https://en.wikipedia.org/wiki/The_Legend_of_Zelda:_Breath_of_the_Wild";

describe("web_search", () => {
  it("lists results as untrusted text without the screen, and says so in Activity", async () => {
    const h = harness();
    const res = await h.call("web_search", { query: "Zelda Breath of the Wild", count: 2 });
    expect(res.body.ok).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(
      /^<untrusted source="web search results for Zelda Breath of the Wild">\n1\. The Legend of Zelda: Breath of the Wild - Wikipedia\n {3}https:\/\/en\.wikipedia\.org\/wiki\/The_Legend_of_Zelda:_Breath_of_the_Wild\n {3}en\.wikipedia\.org · /,
    );
    expect(text).toContain("\n2. Breath of the Wild Walkthrough - The Legend of Zelda Guide\n");
    expect(text).not.toContain("\n3. ");
    expect(h.actions).toEqual([]);
    expect(h.session.tainted).toBe(true);
    expect(h.session.taint.tainted).toBe(false);
    const titles = h.events().filter((e) => e.type === "tool.start");
    expect(titles.map((e) => e.data)).toEqual([
      { tool: "web_search", title: "Searched the web for “Zelda Breath of the Wild”" },
    ]);
    expect(h.events().find((e) => e.type === "step.start")?.data).toEqual({ kind: "browser" });
  });

  it("shows the first pictures of an image search alongside the list", async () => {
    const h = harness();
    const res = await h.call("web_search", { query: "Zelda", kind: "images", count: 6 });
    const pictures = res.body.content.filter((c) => c.type === "web_image");
    expect(pictures).toHaveLength(4);
    for (const picture of pictures) {
      expect(picture).toMatchObject({ mediaType: "image/jpeg" });
      expect(picture).not.toHaveProperty("frameId");
      expect((await sharp(Buffer.from(picture.data ?? "", "base64")).metadata()).format).toBe(
        "jpeg",
      );
    }
    const text = textOf(res);
    expect(text).toContain("   Page: https://");
    expect(text).toContain("   Image: https://");
    expect(text).toContain("(picture shown below)");
    expect(text).toMatch(/^<untrusted source="image search results for Zelda">\n/);
    expect(text).toContain(
      "</untrusted>\n\nThe pictures of results 1, 2, 3, 4 follow, in that order.",
    );
    expect(h.events().find((e) => e.type === "tool.start")?.data).toEqual({
      tool: "web_search",
      title: "Looked at images of “Zelda”",
    });
  });

  it("says why when no engine gives results, naming none to the user", async () => {
    const h = harness({});
    const res = await h.call("web_search", { query: "Zelda" });
    expect(res.body.ok).toBe(false);
    expect(textOf(res)).toContain(
      "No results. html.duckduckgo.com could not be reached; www.bing.com could not be reached.",
    );
    expect(h.events().find((e) => e.type === "step.end")?.data).toEqual({
      status: "failed",
      note: "No search engine gave results.",
    });
  });

  it("is classified as opening the engine's results page for the query", () => {
    expect(toolRisk("web_search", { query: "Zelda Link" })).toEqual({
      operation: "navigate",
      destination: "https://html.duckduckgo.com/html/?q=Zelda+Link",
    });
    expect(toolRisk("web_search", { query: "Zelda", kind: "images" })).toEqual({
      operation: "navigate",
      destination: "https://www.bing.com/images/search?q=Zelda",
    });
    expect(toolRisk("web_fetch", { url: "https://a.example/x?y=1" })).toEqual({
      operation: "navigate",
      destination: "https://a.example/x?y=1",
    });
  });
});

describe("web_fetch", () => {
  it("reads a page as untrusted Markdown without the screen", async () => {
    const h = harness();
    const res = await h.call("web_fetch", { url: ARTICLE, max_chars: 2000 });
    expect(res.body.ok).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(
      /^<untrusted source="web page https:\/\/en\.wikipedia\.org\/wiki\/The_Legend_of_Zelda:_Breath_of_the_Wild">\nTitle: The Legend of Zelda: Breath of the Wild - Wikipedia\nURL: /,
    );
    expect(text).toContain("# The Legend of Zelda: Breath of the Wild");
    expect(h.actions).toEqual([]);
    expect(h.session.tainted).toBe(true);
    expect(h.events().find((e) => e.type === "tool.start")?.data).toEqual({
      tool: "web_fetch",
      title: "Read en.wikipedia.org",
    });
    const shown = h
      .events()
      .filter((e) => e.type === "tool.output")
      .map((e) => (e.data as { chunk: string }).chunk)
      .join("");
    expect(shown.startsWith(`${ARTICLE}\n`)).toBe(true);
    expect(shown).toContain("# The Legend of Zelda: Breath of the Wild");
    expect(shown.length).toBeLessThan(4200);
  });

  it("shows a picture by its link", async () => {
    const h = harness();
    const res = await h.call("web_fetch", { url: "https://upload.wikimedia.org/zelda.png" });
    expect(res.body.content.map((c) => c.type)).toEqual(["text", "web_image"]);
    expect(textOf(res)).toContain("shown at 640×480");
    expect(h.events().find((e) => e.type === "tool.start")?.data).toEqual({
      tool: "web_fetch",
      title: "Looked at a picture from upload.wikimedia.org",
    });
  });

  it("leaves local addresses to the desktop and says what failed", async () => {
    const h = harness();
    for (const url of ["http://localhost:3000/", "http://192.168.1.10/", "file:///etc/passwd"]) {
      const res = await h.call("web_fetch", { url });
      expect(res.body.ok, url).toBe(false);
      expect(textOf(res)).toContain("Open local addresses with browser_navigate");
    }
    expect(h.asked).toEqual([]);
    const pdf = harness({ "papers.example.org": { contentType: "application/pdf" } });
    expect(
      textOf(await pdf.call("web_fetch", { url: "https://papers.example.org/a.pdf" })),
    ).toContain("research op pdf");
    expect(pdf.events().find((e) => e.type === "step.end")?.data).toEqual({
      status: "failed",
      note: "This link is a PDF.",
    });
    const missing = await h.call("web_fetch", { url: "https://gone.example.org/" });
    expect(missing.body.ok).toBe(false);
    expect(textOf(missing)).toContain("fetch failed");
  });

  it("answers a page that already failed in this task at once, without reading it again", async () => {
    const h = harness({ "gone.example.org": { status: 404 } });
    const url = "https://gone.example.org/visit";
    expect((await h.call("web_fetch", { url })).body.ok).toBe(false);
    const again = await h.call("web_fetch", { url: `${url}#hours` });
    expect(again.body.ok).toBe(false);
    expect(textOf(again)).toContain("already failed in this task");
    expect(textOf(again)).toContain("The site answered 404.");
    expect(h.asked).toEqual([url]);
    expect(h.events().filter((e) => e.type === "step.start")).toHaveLength(1);
  });

  it("tries a page that did not answer once more before giving up on it", async () => {
    const asked: string[] = [];
    const web: WebAccess = {
      get: async (url) => {
        asked.push(url.href);
        throw new WebError("The site did not answer in time.");
      },
    };
    const h = toolHarness({ web });
    fixtures.push(h);
    const url = "https://slow.example.org/";
    for (let i = 0; i < 3; i++) await h.call("web_fetch", { url });
    expect(asked).toEqual([url, url]);
  });

  it("is unavailable, not broken, where the daemon has no way out to the web", async () => {
    const h = toolHarness();
    fixtures.push(h);
    for (const [name, input] of [
      ["web_search", { query: "x" }],
      ["web_fetch", { url: "https://example.org/" }],
    ] as const) {
      const res = await h.call(name, input);
      expect(res.body.ok).toBe(false);
      expect(textOf(res)).toContain("Use the web browser instead.");
    }
  });
});

describe("research with the web tools", () => {
  it("never counts a search as a source, and numbers each page read", async () => {
    const h = harness();
    h.session.research = new ResearchLog({ sources: 2, minutes: 30 }, (type, data) =>
      h.session.append(type, data),
    );
    expect(textOf(await h.call("web_search", { query: "Zelda" }))).not.toContain("Source [");
    expect(
      textOf(
        await h.call("web_fetch", { url: "https://html.duckduckgo.com/html/?q=Zelda+Breath" }),
      ),
    ).not.toContain("Source [");
    const read = await h.call("web_fetch", { url: ARTICLE });
    expect(textOf(read)).toMatch(/^Source \[1\] \(1 of about 2 sources, 0 of 30 minutes\)\.\n/);
    expect(h.session.research.sources.map((s) => s.title)).toEqual([
      "The Legend of Zelda: Breath of the Wild - Wikipedia",
    ]);
  });

  it("says in a refused page's step why research takes no new sources", async () => {
    // The user wraps up while the page is being read.
    const web: WebAccess = {
      get: async (url) => {
        h.session.research?.wrapUp();
        return {
          url,
          status: 200,
          contentType: "text/html",
          body: fixture("article.html"),
          truncated: false,
        };
      },
    };
    const h = toolHarness({ web });
    fixtures.push(h);
    h.session.research = new ResearchLog({ sources: 3, minutes: 30 }, (type, data) =>
      h.session.append(type, data),
    );
    await h.call("web_fetch", { url: "https://en.wikipedia.org/wiki/Hyrule" });
    expect(h.events().find((e) => e.type === "step.end")?.data).toEqual({
      status: "blocked",
      note: "You asked dot to wrap up, so it takes no new sources.",
    });
  });

  it("stops new searches and new pages once the budget is reached, but reopens a source", async () => {
    const h = harness();
    h.session.research = new ResearchLog({ sources: 3, minutes: 30 }, (type, data) =>
      h.session.append(type, data),
    );
    h.session.research.add(ARTICLE, "BotW");
    h.session.research.wrapUp();
    const search = await h.call("web_search", { query: "Zelda" });
    expect(search.body.ok).toBe(false);
    expect(textOf(search)).toContain("The user asked you to wrap up.");
    const fresh = await h.call("web_fetch", { url: "https://upload.wikimedia.org/new.png" });
    expect(fresh.body.ok).toBe(false);
    expect(textOf(fresh)).toContain("write the report now");
    const again = await h.call("web_fetch", { url: ARTICLE });
    expect(again.body.ok).toBe(true);
    expect(h.asked.every((url) => !url.includes("duckduckgo"))).toBe(true);
  });
});
