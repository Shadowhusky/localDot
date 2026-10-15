import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { EventLog } from "./event-log.ts";

const PORT = 4750;
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

function scratch() {
  const top = mkdtempSync(join(tmpdir(), "ld-pwa-"));
  const dir = join(top, "dist");
  mkdirSync(join(dir, "icons"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html>localDot</html>");
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('push', () => {});");
  writeFileSync(join(dir, "manifest.webmanifest"), '{"name":"localDot"}');
  writeFileSync(join(dir, "icons", "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, "icons", "apple-touch-icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, "icons", "notes.txt"), "not an icon");
  const eventLog = new EventLog(join(top, "events"));
  const app = createApp({ token: "t".repeat(43), port: PORT, eventLog, ui: { dir } });
  cleanups.push(() => {
    eventLog.close();
    rmSync(top, { recursive: true, force: true });
  });
  return app;
}

describe("Home Screen app files", () => {
  it("serves the worker and manifest without a token, uncached, under the page's policy", async () => {
    const app = scratch();
    const worker = await app.request(url("/sw.js"));
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(worker.headers.get("cache-control")).toBe("no-cache");
    const policy = worker.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    // A same-origin worker and manifest fall back to default-src 'self'; nothing may narrow them.
    expect(policy).not.toMatch(/worker-src|manifest-src|script-src/);
    const manifest = await app.request(url("/manifest.webmanifest"));
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    expect(manifest.headers.get("cache-control")).toBe("no-cache");
  });

  it("supports anonymous Apple icon discovery without exposing other root files", async () => {
    const app = scratch();
    const canonical = await app.request(url("/icons/apple-touch-icon.png"));
    const bytes = await canonical.arrayBuffer();
    for (const path of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) {
      const response = await app.request(url(path));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.arrayBuffer()).toEqual(bytes);
    }
    expect((await app.request(url("/notes.txt"))).status).toBe(404);
    expect((await app.request(url("/api/whoami"))).status).toBe(401);
  });

  it("serves PNG icons only, from the icons folder only", async () => {
    const app = scratch();
    const icon = await app.request(url("/icons/icon-192.png"));
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("cache-control")).not.toContain("immutable");
    expect((await app.request(url("/icons/notes.txt"))).status).toBe(404);
    expect((await app.request(url("/icons/..%2fsw.js"))).status).toBe(404);
    expect((await app.request(url("/icons/..%2findex.html"))).status).toBe(404);
  });
});
