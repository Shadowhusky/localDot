import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoPageError } from "./browser.ts";
import * as memory from "./memory.ts";
import { addToolRoutes } from "./routes.ts";

const owned: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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

  it("stops a named shell run and still reports its confirmed result", async () => {
    const { post } = setup();
    const id = "run-0123456789abcdef";
    const running = post("/shell", { command: "echo started; sleep 30", id });
    let stop = await post("/shell/stop", { id });
    for (let i = 0; stop.status === 404 && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 20));
      stop = await post("/shell/stop", { id });
    }
    expect(stop.status).toBe(204);
    const lines = (await (await running).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ done: true, exitCode: null, signal: "SIGKILL" });
    expect((await post("/shell/stop", { id })).status).toBe(404);
  });

  it("refuses an unknown or duplicate shell run id", async () => {
    const { post } = setup();
    const id = "run-fedcba9876543210";
    expect((await post("/shell/stop", { id })).status).toBe(404);
    expect((await post("/shell/stop", { id: "bad id" })).status).toBe(400);
    const running = post("/shell", { command: "sleep 30", id });
    let duplicate = await post("/shell", { command: "true", id });
    for (let i = 0; duplicate.status !== 409 && i < 100; i++) {
      await duplicate.text();
      await new Promise((r) => setTimeout(r, 20));
      duplicate = await post("/shell", { command: "true", id });
    }
    expect(duplicate.status).toBe(409);
    expect((await post("/shell/stop", { id })).status).toBe(204);
    await (await running).text();
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

describe("shell terminal receipts", () => {
  it("retains completion after transport loss and refuses replay of the same id", async () => {
    const { post } = setup();
    const id = "receipt-0123456789abcdef";
    const response = await post("/shell", { id, command: "printf once > once.txt" });
    expect(response.headers.get("x-localdot-shell-result")).toBe("1");
    await response.text();
    const receipt = await post("/shell/result", { id });
    expect(await receipt.json()).toMatchObject({ id, result: { done: true, exitCode: 0 } });
    expect((await post("/shell", { id, command: "printf twice > once.txt" })).status).toBe(409);
    expect(await (await post("/files/read", { path: "once.txt" })).json()).toMatchObject({
      content: "once",
    });
    expect((await post("/shell/result", { id: "unknown-0123456789abcdef" })).status).toBe(404);
  });
  it("refuses new work before spawning when desktop memory is critical", async () => {
    vi.spyOn(memory, "desktopMemory").mockResolvedValue({
      currentBytes: 99,
      workingSetBytes: 99,
      limitBytes: 100,
      oomKills: 0,
      pressure: "critical",
    });
    const { post } = setup();
    const response = await post("/shell", { command: "touch should-not-exist" });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("desktop_memory_pressure");
    expect((await post("/files/read", { path: "should-not-exist" })).status).toBe(404);
  });
});

it("refuses a new command when only the shared VM is critically stalled", async () => {
  vi.spyOn(memory, "desktopMemory").mockResolvedValue({
    currentBytes: 10,
    workingSetBytes: 10,
    limitBytes: 100,
    oomKills: 0,
    pressure: "normal",
    vm: { totalBytes: 1000, availableBytes: 10, pressure: "critical" },
  });
  const { post } = setup();
  expect((await post("/shell", { command: "touch should-not-exist" })).status).toBe(503);
  expect((await post("/files/read", { path: "should-not-exist" })).status).toBe(404);
});
