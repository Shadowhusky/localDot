import { type DefaultTreeAdapterTypes as Html, parse } from "parse5";
import { describe, expect, it } from "vitest";
import { quietPage } from "./quiet-page.ts";

const KEY = `sk-proj-${"Q".repeat(40)}`;

// Every element as the browser builds it from the served page (scripting off, as in the frame).
function elements(html: string): Html.Element[] {
  const out: Html.Element[] = [];
  const walk = (node: Html.ParentNode) => {
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      out.push(child);
      walk(child);
      if ("content" in child) walk(child.content);
    }
  };
  walk(parse(html, { scriptingEnabled: false }));
  return out;
}
const links = (html: string) =>
  elements(html)
    .filter((e) => e.tagName === "link")
    .map((e) => e.attrs.find((a) => a.name === "rel")?.value);
const reaching = (html: string) =>
  elements(html).flatMap((e) =>
    e.attrs
      .filter((a) => ["target", "ping", "formtarget", "show"].includes(a.name))
      .map((a) => `${e.tagName} ${a.name}`),
  );
const served = (html: string) => {
  const page = quietPage(html);
  if (page === undefined) throw new Error("not served");
  return page;
};

describe("a page as the preview serves it", () => {
  it("keeps stylesheets and takes out every other link", () => {
    const page = served(`<!doctype html><head>
      <link rel="stylesheet" href="summary.css"><link REL=" StyleSheet " href=b.css>
      <link rel=preconnect href="https://a.example"><link rel=DNS-PREFETCH href=//b.example>
      <link rel=prefetch href=//c.example/x><link rel=preload as=image href=//d.example/y.png>
      <link rel=modulepreload href=//e.example/m.js><link rel=prerender href=//f.example/>
      <link rel="stylesheet preconnect" href=//g.example/><link rel="alternate stylesheet" href=h.css>
      <link rel=icon href=//i.example/i.png><link href=//j.example/>
      <link rel=stylesheet rel=preconnect href=k.css><link rel=preconnect rel=stylesheet href=//l.example/>
      </head><body><p>Hello</p></body>`);
    expect(links(page)).toEqual(["stylesheet", " StyleSheet ", "stylesheet"]);
    expect(page).toContain("<p>Hello</p>");
  });

  it("takes out where any link opens and what reports a click, everywhere in the page", () => {
    const page = served(`<head><base target=_blank></head><body>
      <a href=//a.example target=_blank ping=//p.example/ping>a</a>
      <a href=//b.example TARGET="_top">b</a><map><area href=//c.example target=x></map>
      <form><button formtarget=_blank>go</button></form>
      <svg><a href=//d.example target=_blank xlink:show=new><text>d</text></a></svg>
      <template><a href=//e.example target=_blank>e</a></template>
      <noscript><a href=//f.example target=_blank>f</a><link rel=preconnect href=//f.example></noscript>
      </body>`);
    expect(reaching(page)).toEqual([]);
    expect(links(page)).toEqual([]);
    expect(elements(page).filter((e) => e.tagName === "a")).toHaveLength(5);
  });

  it("takes out frames, objects and embeds, whose own pages it does not read", () => {
    const page = served(`<p>before</p>
      <iframe srcdoc="<link rel=preconnect href=//a.example>"></iframe>
      <svg><foreignObject><iframe srcdoc="&lt;link rel=preconnect href=//b.example&gt;"></iframe></foreignObject></svg>
      <object data=//c.example/x>fallback</object><embed src=//d.example/y>
      <template><iframe srcdoc="<a href=//e.example target=_blank>e</a>"></iframe></template>
      <p>after</p>`);
    const framed = served("<frameset><frame src=//f.example></frameset>");
    const kinds = [...elements(page), ...elements(framed)].map((e) => e.tagName);
    for (const kind of ["iframe", "frame", "object", "embed"]) expect(kinds).not.toContain(kind);
    expect(page).not.toContain("srcdoc");
    expect(page).toContain("<p>before</p>");
    expect(page).toContain("<p>after</p>");
  });

  it("reads comments, raw text and odd attributes as the browser does", () => {
    const page = served(
      `<!-- <a title="--> <a href=//a.example target=_blank>">a</a>` +
        `<style>a::after { content: "<link rel=preconnect href=//b.example>" }</style>` +
        `<p title='x'target=_blank>b</p><a/target=_blank href=//c.example>c</a>` +
        `<svg></p><style><a id="</style><link rel=preconnect href=//d.example>">`,
    );
    expect(reaching(page)).toEqual([]);
    expect(links(page)).toEqual([]);
  });

  it("leaves words in the text alone", () => {
    const page = served(
      `<pre>target = df["y"]; ping = 3</pre><p>&lt;link rel=preconnect&gt; and target=_blank</p>`,
    );
    expect(page).toContain(`<pre>target = df["y"]; ping = 3</pre>`);
    expect(page).toContain("<p>&lt;link rel=preconnect&gt; and target=_blank</p>");
  });

  it("masks keys, written plainly or as character references", () => {
    const page = served(`<p>${KEY}</p><p title="${KEY.replace("-", "&#45;")}">x</p>`);
    expect(page).not.toContain("sk-proj");
    expect(page).toContain("<p>••••</p>");
  });

  it("serves nothing that the masking would turn back into a link", () => {
    expect(quietPage(`<${KEY} title="<link rel=preconnect href=//a.example>">x</${KEY}>`)).toBe(
      undefined,
    );
  });

  it("serves nothing nested deeper than it can check", () => {
    const nest = (n: number) => `${"<div>".repeat(n)}x${"</div>".repeat(n)}`;
    expect(quietPage(nest(200))).toContain("x");
    expect(quietPage(nest(300))).toBe(undefined);
  });

  it("serves nothing that builds far more elements than it is written with", () => {
    const left = ["b", "i", "u", "s", "em", "strong", "small", "code"]
      .map((tag) => `<${tag}>`.repeat(3))
      .join("");
    // Formatting left open in one paragraph is made again in every paragraph after it.
    expect(quietPage(`<p>${left}${"<p>x".repeat(30_000)}`)).toBe(undefined);
    const page = `<p><b>Totals</p>${"<p>Net rose in every region.</p>".repeat(1000)}`;
    expect(quietPage(page)).toContain("<p><b>Net rose in every region.</b></p>");
  });
});
