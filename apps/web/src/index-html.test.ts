import { describe, expect, it } from "vitest";
import page from "../index.html?raw";
import icon from "./favicon.svg?raw";

describe("index.html", () => {
  // Without one, the browser asks for /favicon.ico, which the daemon answers with 404. The icon is
  // a bundled file, so it is served from /assets under the page's img-src 'self'.
  it("declares an icon that the build bundles", () => {
    expect(page).toContain('<link rel="icon" type="image/svg+xml" href="/src/favicon.svg" />');
    expect(icon).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  });

  // The phone's Home Screen app: files from public/ that the build copies to the dist root as is.
  it("links the Home Screen manifest and icon", () => {
    expect(page).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(page).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
    expect(page).toContain('<meta name="theme-color" content="#0a0b0d" />');
    expect(page).toContain('<meta name="apple-mobile-web-app-title" content="localDot" />');
  });

  it("keeps everything the CSP refuses out: no inline script or style", () => {
    expect(page).not.toMatch(/<style/);
    expect(page).not.toMatch(/\sstyle=/);
    for (const script of page.match(/<script[^>]*>/g) ?? []) expect(script).toMatch(/\ssrc="/);
  });
});
