import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { EventLog } from "./event-log.ts";

const PORT = 4750;
const TOKEN = "t".repeat(43);
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;

function appWithUi(dir: string) {
  return createApp({
    token: TOKEN,
    port: PORT,
    eventLog: new EventLog(mkdtempSync(join(tmpdir(), "local dot's ui-"))),
    ui: { dir },
  });
}

describe("serveUi", () => {
  it("serves index.html and hashed assets without a token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local dot's dist-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<html>localDot</html>");
    writeFileSync(join(dir, "assets", "index-abc.js"), "// app");
    const app = appWithUi(dir);
    const index = await app.request(url("/"));
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await index.text()).toContain("localDot");
    const asset = await app.request(url("/assets/index-abc.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    // URL parsing folds "../" and "%2e%2e/" away before routing; an encoded separator survives and
    // reaches readStatic's guard, aimed at a file that exists outside dist.
    writeFileSync(join(tmpdir(), "ld-ui-outside.txt"), "secret");
    const outside = await app.request(url("/assets/..%2f..%2fld-ui-outside.txt"));
    expect(outside.status).toBe(404);
    expect(outside.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("explains how to build the UI when dist is missing", async () => {
    const res = await appWithUi(join(tmpdir(), "local dot's missing-dist")).request(url("/"));
    expect(res.status).toBe(503);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("pnpm --filter @localdot/web build");
  });
});
