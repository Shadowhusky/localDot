import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { NoPageError } from "./browser.ts";
import { addToolRoutes } from "./routes.ts";

const owned: string[] = [];
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "local dot's routes-")));
  owned.push(home);
  const navigations: string[] = [];
  const app = new Hono();
  addToolRoutes(app, {
    home,
    env: { PATH: process.env.PATH, LOCALDOT_DESKTOPD_TOKEN: "secret-token-value-0123456789" },
    browser: {
      page: async () => ({ url: "https://accounts.google.com/signin" }),
      read: async () => {
        throw new NoPageError();
      },
      navigate: async (url) => {
        navigations.push(url);
        return { url, title: "t", loaded: true };
      },
    },
  });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, home, post, navigations };
}

describe("desktopd's tool routes", () => {
  it("streams a shell command as NDJSON ending in its result", async () => {
    const { post } = setup();
    const res = await post("/shell", { command: "echo hi; echo $LOCALDOT_DESKTOPD_TOKEN" });
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(
      lines
        .slice(0, -1)
        .map((l) => l.chunk)
        .join(""),
    ).toBe("hi\n\n");
    expect(lines.at(-1)).toMatchObject({ done: true, exitCode: 0 });
  });

  it("refuses a shell working directory outside the home", async () => {
    const { post } = setup();
    expect((await post("/shell", { command: "ls", cwd: "/etc" })).status).toBe(400);
  });

  it("maps file errors to statuses", async () => {
    const { post } = setup();
    expect((await post("/files/read", { path: "missing.txt" })).status).toBe(404);
    expect((await post("/files/write", { path: "../x", content: "" })).status).toBe(400);
    expect((await post("/files/write", { path: "a.txt", content: "a\na\n" })).status).toBe(200);
    expect((await post("/files/edit", { path: "a.txt", oldText: "a", newText: "b" })).status).toBe(
      409,
    );
    expect((await post("/files/list", { path: "~" })).status).toBe(200);
    expect((await post("/files/read", { nope: 1 })).status).toBe(400);
  });

  it("puts and fetches bytes", async () => {
    const { app } = setup();
    const put = await app.request("/files/put?path=Downloads/a.bin&mode=644", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });
    expect(await put.json()).toEqual({ path: "~/Downloads/a.bin", bytes: 3 });
    const got = await app.request("/files/fetch?path=Downloads/a.bin");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(
      (await app.request("/files/put?path=x&mode=rwx", { method: "POST", body: "x" })).status,
    ).toBe(400);
  });

  it("opens only web pages, and says when Chromium has no page", async () => {
    const { post, navigations } = setup();
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "chrome://settings",
      "data:text/html,x",
    ]) {
      expect((await post("/browser/navigate", { url })).status, url).toBe(400);
    }
    expect((await post("/browser/navigate", { url: "example.com" })).status).toBe(200);
    expect(navigations).toEqual(["https://example.com/"]);
    expect((await post("/browser/read", {})).status).toBe(409);
  });

  it("gives the front page's address alone", async () => {
    const { app } = setup();
    const res = await app.request("/browser/page");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://accounts.google.com/signin" });
  });
});
