import { describe, expect, it } from "vitest";
import exportPage from "../export.html?raw";
import page from "../index.html?raw";
import icon from "./favicon.svg?raw";

describe("index.html", () => {
  // Without one, the browser asks for /favicon.ico, which the daemon answers with 404. The icon is
  // a bundled file, so it is served from /assets under the page's img-src 'self'.
  it("declares an icon that the build bundles", () => {
    expect(page).toContain('<link rel="icon" type="image/svg+xml" href="/src/favicon.svg" />');
    expect(icon).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  });

  it("keeps everything the CSP refuses out: no inline script or style", () => {
    for (const html of [page, exportPage]) {
      expect(html).not.toMatch(/<style/);
      expect(html).not.toMatch(/\sstyle=/);
      for (const script of html.match(/<script[^>]*>/g) ?? []) expect(script).toMatch(/\ssrc="/);
    }
  });
});
