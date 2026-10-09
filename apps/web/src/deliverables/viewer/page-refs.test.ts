import { describe, expect, it } from "vitest";
import { loadsFromWeb } from "./page-refs.ts";

describe("a page's pictures from the web", () => {
  it("notices pictures, stylesheets, fonts and media from any web address", () => {
    for (const html of [
      '<img src="https://images.example.test/a.png">',
      "<img src=//cdn.example.test/a.png>",
      '<img srcset="http://example.test/a.png 2x">',
      '<video poster="https://example.test/p.jpg"></video>',
      '<link rel="stylesheet" href="https://example.test/a.css">',
      "<div style=\"background: url('https://example.test/bg.png')\"></div>",
      '<style>@import "https://example.test/x.css";</style>',
      "<style>@font-face { src: url(https://example.test/f.woff2) }</style>",
    ])
      expect(loadsFromWeb(html), html).toBe(true);
  });

  it("leaves out links, the task's own files and embedded pictures", () => {
    for (const html of [
      '<a href="https://example.test/">a link</a>',
      '<img src="chart.png">',
      '<link rel="stylesheet" href="page.css">',
      '<img src="data:image/png;base64,iVBOR">',
      "<p>see https://example.test</p>",
    ])
      expect(loadsFromWeb(html), html).toBe(false);
  });
});
