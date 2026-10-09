import { join } from "node:path";
import type { Hono } from "hono";
import { runtimeLayout } from "./runtime-layout.ts";
import { readStatic } from "./static-files.ts";

export function webDir(sub: string): string {
  return join(runtimeLayout.web, sub);
}

const BUILD_HINT = "UI not built: run pnpm --filter @localdot/web build";
const NOSNIFF = { "x-content-type-options": "nosniff" };
// The Theatre and its render worker load and talk to this origin only. The assets carry it too:
// a worker script is governed by the policy it is served with. No page frames the Theatre, not even
// one of this origin: the vendored client's cell can point that client's frame at any same-origin
// URL (Selkies' settings handler assigns window[key] for each key the cell sends), and a Theatre
// loaded there would act on a fragment token the cell chose.
export const UI_CSP = {
  "referrer-policy": "no-referrer",
  "content-security-policy": [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; "),
};

export function serveUi(app: Hono, dir: string): void {
  // The export page is the daemon's own: its headless browser makes videos there.
  for (const [path, page] of [
    ["/", "/index.html"],
    ["/export.html", "/export.html"],
  ] as const)
    app.get(path, (c) => {
      const file = readStatic(dir, page);
      if (!file) return c.text(BUILD_HINT, 503, NOSNIFF);
      return c.body(file.body, 200, {
        ...NOSNIFF,
        ...UI_CSP,
        "content-type": file.type,
        "cache-control": "no-store",
      });
    });
  // Rooted at dist/assets, so an encoded separator ("/assets/..%2findex.html") can't reach the
  // page and serve it with the assets' immutable caching.
  app.get("/assets/*", (c) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname).slice("/assets".length);
    } catch {
      return c.text("bad path", 400, NOSNIFF);
    }
    const file = readStatic(join(dir, "assets"), rel);
    if (!file) return c.text("not found", 404, NOSNIFF);
    return c.body(file.body, 200, {
      ...NOSNIFF,
      ...UI_CSP,
      "content-type": file.type,
      "cache-control": "public, max-age=31536000, immutable",
    });
  });
}
