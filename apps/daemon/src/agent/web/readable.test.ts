import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { plainText, readable } from "./readable.ts";

// An encyclopedia article saved in October 2026: its lead and first sections, with the site's
// menus, sidebars and footer, scripts and styles taken out.
const article = readFileSync(new URL("./fixtures/article.html", import.meta.url), "utf8");
const ARTICLE_URL = "https://en.wikipedia.org/wiki/The_Legend_of_Zelda:_Breath_of_the_Wild";

describe("a page's readable text", () => {
  it("reads an article as Markdown, without the site around it", () => {
    const page = readable(article, ARTICLE_URL, 100_000);
    expect(page?.title).toBe("The Legend of Zelda: Breath of the Wild - Wikipedia");
    const text = page?.text ?? "";
    expect(text.startsWith("# The Legend of Zelda: Breath of the Wild")).toBe(true);
    expect(text).toContain("\n## Gameplay\n");
    expect(text).toContain(
      "The Legend of Zelda: Breath of the Wild[b] is a 2017 action-adventure game developed by Nintendo EPD for the Wii U and Nintendo Switch.",
    );
    expect(text).toContain("| Developer | Nintendo EPD[a] |");
    expect(text).toMatch(
      /!\[An image of the Breath of the Wild's boxart\]\(https:\/\/[^)]*The_Legend_of_Zelda_Breath_of_the_Wild\.jpg[^)]*\)/,
    );
    for (const chrome of ["Main menu", "Create account", "Privacy policy", "Toggle the table"])
      expect(text, chrome).not.toContain(chrome);
    expect(text).toContain("\n\nLinks:\n- ");
    expect(text).toContain("- Nintendo EPD: https://en.wikipedia.org/wiki/Nintendo_EPD");
    expect(page?.truncated).toBe(false);
  });

  it("cuts at the size asked for, the links included, and says so", () => {
    const page = readable(article, ARTICLE_URL, 3000);
    expect(page?.truncated).toBe(true);
    expect(page?.text.length).toBeLessThanOrEqual(3000 + 40);
    expect(page?.text).toContain("(page text cut)");
  });

  it("leaves out what is hidden, menus and forms, and keeps lists, code and quotes", () => {
    const html = `<!doctype html><html><head><title>Notes</title></head><body>
      <nav><a href="/">Home</a></nav>
      <main>
        <h1>Recipe</h1>
        <p hidden>secret tracking text</p>
        <div style="display: none">invisible</div>
        <div class="cookie-banner">Accept cookies</div>
        <p>Mix the <a href="/flour">flour</a> and <a href="#step2">water</a>.</p>
        <ol><li>Knead<ul><li>ten minutes</li></ul></li><li>Bake</li></ol>
        <pre><code>temp = 220
time = 30</code></pre>
        <blockquote>Good bread takes time.</blockquote>
        <form><input value="typed"><button>Send</button></form>
        <img src="/bread.jpg" alt="A loaf"><img src="/dot.gif" width="1" alt="pixel">
        <p>${"Long enough to be the article. ".repeat(8)}</p>
      </main>
      <footer>Copyright</footer>
    </body></html>`;
    const page = readable(html, "https://bake.example.org/bread", 10_000);
    const text = page?.text ?? "";
    expect(text).toContain("# Recipe");
    expect(text).toContain("Mix the flour and water.");
    expect(text).toContain("1. Knead\n  - ten minutes\n2. Bake");
    expect(text).toContain("```\ntemp = 220\ntime = 30\n```");
    expect(text).toContain("> Good bread takes time.");
    expect(text).toContain("![A loaf](https://bake.example.org/bread.jpg)");
    for (const absent of ["secret tracking", "invisible", "Accept cookies", "typed", "Send"])
      expect(text, absent).not.toContain(absent);
    expect(text).not.toMatch(/Home|Copyright|pixel/);
    expect(text).toContain("- flour: https://bake.example.org/flour");
    expect(text).not.toContain("#step2");
  });

  it("keeps a picture's link whole: tracking left out, and never cut inside a table cell", () => {
    const long = "x".repeat(280);
    const html = `<main><table><tr><td>${long} <img src="https://upload.example.org/zelda.png?utm_source=wiki&w=250" alt="Zelda"></td></tr></table><p>${"Text. ".repeat(40)}</p></main>`;
    const text = readable(html, "https://wiki.example.org/Zelda", 10_000)?.text ?? "";
    expect(text).toContain(`| ${long} |`);
    expect(text).not.toContain("![Zelda](https://upload.example.org/zelda.png?w=2");
    const short = readable(html.replace(long, "Artwork"), "https://wiki.example.org/Zelda", 10_000);
    expect(short?.text).toContain(
      "| Artwork ![Zelda](https://upload.example.org/zelda.png?w=250) |",
    );
  });

  it("reads the body when a page has no main part, and gives up on pages nested past reading", () => {
    expect(readable("<title>T</title><p>Just text</p>", "https://a.example.org/", 1000)).toEqual({
      title: "T",
      text: "Just text",
      truncated: false,
    });
    expect(readable("<div>".repeat(5000), "https://a.example.org/", 1000)).toBeUndefined();
  });

  it("keeps plain text as it came, within the size", () => {
    expect(plainText("a\r\nb", 100)).toEqual({ text: "a\nb", truncated: false });
    expect(plainText("😀".repeat(10), 3)).toEqual({ text: "😀😀😀\n(text cut)", truncated: true });
  });
});
