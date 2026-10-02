import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { EventLog } from "./event-log.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;
// No page may frame the Theatre: a cell can point the vendored client's frame at any same-origin
// URL, and a Theatre loaded there would act on a fragment token the cell chose.
const UI_CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; " +
  "base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
});

// A scratch folder holding dist (index.html, assets/index-abc.js) and, beside dist, a file no
// request may reach. Each test removes its folder.
function scratch(uiDir?: string) {
  const top = mkdtempSync(join(tmpdir(), "local dot's ui-"));
  const dir = join(top, "dist");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html>localDot</html>");
  writeFileSync(join(dir, "assets", "index-abc.js"), "// app");
  writeFileSync(join(top, "ld-ui-outside.txt"), "secret");
  const eventLog = new EventLog(join(top, "events"));
  const app = createApp({ token: TOKEN, port: PORT, eventLog, ui: { dir: uiDir ?? dir } });
  cleanups.push(() => {
    eventLog.close();
    rmSync(top, { recursive: true, force: true });
  });
  return { top, dir, app };
}

describe("serveUi", () => {
  it("serves index.html and hashed assets without a token", async () => {
    const { app } = scratch();
    const index = await app.request(url("/"));
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");
    expect(index.headers.get("content-security-policy")).toBe(UI_CSP);
    expect(await index.text()).toContain("localDot");
    const asset = await app.request(url("/assets/index-abc.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    // A worker script is governed by the policy it is served with, not its page's.
    expect(asset.headers.get("content-security-policy")).toBe(UI_CSP);
  });

  it("forbids every page, its own origin included, to frame the Theatre", async () => {
    const { app } = scratch();
    const policy = (await app.request(url("/"))).headers.get("content-security-policy") ?? "";
    const framing = policy
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.startsWith("frame-ancestors"));
    expect(framing).toEqual(["frame-ancestors 'none'"]);
  });

  it("serves /assets/* from dist/assets only, never index.html or a file outside dist", async () => {
    const { app } = scratch();
    // URL parsing folds "../" and "%2e%2e/" away before routing; an encoded separator survives
    // and reaches the file lookup.
    for (const path of [
      "/assets/..%2findex.html",
      "/assets/..%2f..%2fld-ui-outside.txt",
      "/assets/",
    ]) {
      const res = await app.request(url(path));
      expect(res.status, path).toBe(404);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("cache-control"), path).toBeNull();
    }
  });

  it("refuses a symlink in dist that leads outside it, and serves one that stays inside", async () => {
    const { top, dir, app } = scratch();
    symlinkSync(join(top, "ld-ui-outside.txt"), join(dir, "assets", "leak.js"));
    symlinkSync(top, join(dir, "assets", "up"));
    symlinkSync(join(dir, "assets", "index-abc.js"), join(dir, "assets", "alias.js"));
    expect((await app.request(url("/assets/leak.js"))).status).toBe(404);
    expect((await app.request(url("/assets/up/ld-ui-outside.txt"))).status).toBe(404);
    expect((await app.request(url("/assets/alias.js"))).status).toBe(200);
  });

  it("explains how to build the UI when dist is missing", async () => {
    const res = await scratch("/nonexistent/local dot's missing-dist").app.request(url("/"));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("pnpm --filter @localdot/web build");
  });
});
