import { describe, expect, it } from "vitest";
import exportPage from "../export.html?raw";
import page from "../index.html?raw";

describe("index.html", () => {
  it("declares the detailed PNG mascot for browser bookmark clients", () => {
    expect(page).toContain(
      '<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png?v=mascot-2" />',
    );
  });

  // The phone's Home Screen app: files from public/ that the build copies to the dist root as is.
  it("links the Home Screen manifest and icon", () => {
    expect(page).toContain(
      '<link rel="manifest" crossorigin="use-credentials" href="/manifest.webmanifest" />',
    );
    expect(page).toContain(
      '<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-mascot-2.png" />',
    );
    expect(page).toContain('<meta name="theme-color" content="#0a0b0d" />');
    expect(page).toContain('<meta name="apple-mobile-web-app-title" content="localDot" />');
  });

  it("keeps everything the CSP refuses out: no inline script or style", () => {
    for (const html of [page, exportPage]) {
      expect(html).not.toMatch(/<style/);
      expect(html).not.toMatch(/\sstyle=/);
      for (const script of html.match(/<script[^>]*>/g) ?? []) expect(script).toMatch(/\ssrc="/);
    }
  });
});
