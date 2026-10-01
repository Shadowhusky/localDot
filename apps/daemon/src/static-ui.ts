import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { readStatic } from "./static-files.ts";

// apps/daemon/src → apps/web/<sub>; fileURLToPath keeps the apostrophe in the repo path intact.
export function webDir(sub: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", sub);
}

const BUILD_HINT = "UI not built: run pnpm --filter @localdot/web build";
const NOSNIFF = { "x-content-type-options": "nosniff" };

export function serveUi(app: Hono, dir: string): void {
  app.get("/", (c) => {
    const file = readStatic(dir, "/index.html");
    if (!file) return c.text(BUILD_HINT, 503, NOSNIFF);
    return c.body(file.body, 200, {
      ...NOSNIFF,
      "content-type": file.type,
      "cache-control": "no-store",
    });
  });
  app.get("/assets/*", (c) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("bad path", 400, NOSNIFF);
    }
    const file = readStatic(dir, rel);
    if (!file) return c.text("not found", 404, NOSNIFF);
    return c.body(file.body, 200, {
      ...NOSNIFF,
      "content-type": file.type,
      "cache-control": "public, max-age=31536000, immutable",
    });
  });
}
