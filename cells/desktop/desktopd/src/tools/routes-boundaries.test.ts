import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellFailure } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopdApp } from "../app.ts";
import { NoPageError } from "./browser.ts";
import type { ToolRouteDeps } from "./routes.ts";
import { ShellTerminationError } from "./shell.ts";

const TOKEN = "t".repeat(43);
const auth = { authorization: `Bearer ${TOKEN}` };
const owned: string[] = [];
afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup(extra: Partial<ToolRouteDeps> = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "localdot-route-boundary-")));
  owned.push(home);
  const shell = vi.fn<ToolRouteDeps["runShell"] & {}>(async (_opts, output) => {
    output({ stream: "stdout", chunk: "hello\n" });
    return { done: true, exitCode: 0, signal: null, timedOut: false, truncated: false, ms: 1 };
  });
  const browser = {
    read: vi.fn(async () => {
      throw new NoPageError();
    }),
    navigate: vi.fn(async (url: string) => ({ url, title: "fixture", loaded: true })),
  };
  const app = createDesktopdApp({
    token: TOKEN,
    scale: 1,
    display: ":fixture",
    readXsettings: async () => null,
    readScreen: async () => null,
    tools: {
      home,
      env: { PATH: "/usr/bin:/bin", LOCALDOT_DESKTOPD_TOKEN: TOKEN, PASSWORD: "stream-secret" },
      browser,
      runShell: shell,
      ...extra,
    },
  });
  const post = (path: string, value: unknown, init: RequestInit = {}) =>
    app.request(path, {
      method: "POST",
      body: JSON.stringify(value),
      headers: { ...auth, "content-type": "application/json" },
      ...init,
    });
  return { home, app, post, shell, browser };
}

function source(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const part of parts) c.enqueue(part);
      c.close();
    },
  });
}
function request(
  path: string,
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  headers: NonNullable<RequestInit["headers"]> = auth,
) {
  return new Request(`http://desktopd${path}`, {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
    signal,
  } as RequestInit);
}

describe("authenticated desktop tool boundaries", () => {
  it("requires the bearer on every new endpoint before consuming a body or executing tools", async () => {
    const { app, shell, browser, home } = setup();
    for (const path of [
      "/shell",
      "/files/read",
      "/files/write",
      "/files/edit",
      "/files/list",
      "/files/put?path=new",
      "/browser/read",
      "/browser/navigate",
    ]) {
      let reads = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            reads++;
            c.enqueue(Buffer.from("x"));
          },
        },
        { highWaterMark: 0 },
      );
      const response = await app.fetch(request(path, stream, undefined, {}));
      expect(response.status, path).toBe(401);
      expect(reads, path).toBe(0);
      await stream.cancel();
    }
    expect((await app.request("/files/fetch?path=x")).status).toBe(401);
    expect(shell).not.toHaveBeenCalled();
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it("keeps 64 KiB on original routes and permits bounded larger tool writes/uploads", async () => {
    const { app, post, home } = setup();
    expect((await post("/type", { text: "x".repeat(70 * 1024) })).status).toBe(413);
    expect(
      (await post("/files/write", { path: "large", content: "x".repeat(70 * 1024) })).status,
    ).toBe(200);
    const response = await app.fetch(
      request("/files/put?path=raw", source(Buffer.alloc(70 * 1024, 65))),
    );
    expect(response.status).toBe(200);
    expect(readFileSync(join(home, "raw"))).toHaveLength(70 * 1024);
    expect(
      (await post("/files/write", { path: "huge", content: "x".repeat(5 * 1024 * 1024) })).status,
    ).toBe(413);
    expect(existsSync(join(home, "huge"))).toBe(false);
  });

  it("bounds every small tool body even when Content-Length understates a chunked request", async () => {
    const { app, shell, browser, home } = setup();
    for (const path of [
      "/shell",
      "/files/read",
      "/files/list",
      "/browser/read",
      "/browser/navigate",
    ]) {
      const response = await app.fetch(
        request(path, source(Buffer.alloc(64 * 1024, 32), Buffer.from("x")), undefined, {
          ...auth,
          "content-length": "1",
        }),
      );
      expect(response.status, path).toBe(413);
    }
    expect(shell).not.toHaveBeenCalled();
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it("aborts partially received JSON tool bodies without executing a tool", async () => {
    const { app, shell, browser, home } = setup();
    for (const path of [
      "/shell",
      "/files/read",
      "/files/write",
      "/files/edit",
      "/files/list",
      "/browser/read",
      "/browser/navigate",
    ]) {
      const abort = new AbortController();
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(Buffer.from('{"'));
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = app.fetch(request(path, stream, abort.signal));
      await Promise.resolve();
      abort.abort(new Error("disconnected"));
      expect((await response).status, path).toBe(408);
      expect(cancelled, path).toBe(true);
    }
    expect(shell).not.toHaveBeenCalled();
    expect(browser.read).not.toHaveBeenCalled();
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it("refuses invalid JSON and invalid UTF-8 without leaking parser diagnostics", async () => {
    const { app, home } = setup();
    for (const bytes of [Buffer.from('{"path":"new",'), Buffer.from([0xff])]) {
      const response = await app.fetch(request("/files/write", source(bytes)));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("invalid JSON body");
    }
    expect(readdirSync(home)).toEqual([]);
  });

  it("enforces raw byte limits with missing or misleading Content-Length", async () => {
    const { app, home } = setup({ maxPutBytes: 4 });
    for (const headers of [auth, { ...auth, "content-length": "1" }]) {
      const response = await app.fetch(
        request(
          "/files/put?path=bad",
          source(Buffer.from("abc"), Buffer.from("def")),
          undefined,
          headers,
        ),
      );
      expect(response.status).toBe(413);
    }
    expect(readdirSync(home)).toEqual([]);
    const exact = await app.fetch(request("/files/put?path=exact", source(Buffer.from("abcd"))));
    expect(await exact.json()).toEqual({ path: "~/exact", bytes: 4 });
  });

  it("validates a shell request and strips daemon credentials before dispatch", async () => {
    const { post, shell, home } = setup();
    expect((await post("/shell", { command: "hello" })).status).toBe(200);
    await Promise.resolve();
    expect(shell.mock.calls[0]?.[0]).toMatchObject({
      cwd: home,
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });
    expect(shell.mock.calls[0]?.[0].env).not.toHaveProperty("LOCALDOT_DESKTOPD_TOKEN");
    expect(shell.mock.calls[0]?.[0].env).not.toHaveProperty("PASSWORD");
    expect((await post("/shell", { command: "x", cwd: "../escape" })).status).toBe(400);
    expect((await post("/shell", { command: "x", timeoutMs: 0 })).status).toBe(400);
    expect(shell).toHaveBeenCalledTimes(1);
  });

  it("sends a safe typed terminal failure instead of ShellDone when cleanup is uncertain", async () => {
    const { post } = setup({
      runShell: async () => {
        throw new ShellTerminationError(123, new Error(`secret ${TOKEN}`));
      },
    });
    const response = await post("/shell", { command: "secret command" });
    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(ShellFailure.safeParse(lines[0]).success).toBe(true);
    expect(lines[0]).toMatchObject({ status: 500, code: "shell_cleanup_uncertain" });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("123");
    expect(text).not.toContain("secret command");
    expect(text).not.toContain('"done"');
  });

  it("aborts an active shell on response cancellation and emits no completion", async () => {
    let active: AbortSignal | undefined;
    let observedAbort = false;
    const { post } = setup({
      runShell: async (opts, output) => {
        active = opts.signal;
        output({ stream: "stdout", chunk: "running" });
        await new Promise<void>((resolve) =>
          opts.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          ),
        );
        throw new ShellTerminationError(123, new Error("cancelled cleanup"));
      },
    });
    const response = await post("/shell", { command: "fixture" });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.cancel();
    await Promise.resolve();
    expect(active?.aborted).toBe(true);
    expect(observedAbort).toBe(true);
  });

  it("rejects a pre-aborted request before starting shell or files", async () => {
    const { app, post, shell, home } = setup();
    const signal = AbortSignal.abort(new Error("stopped"));
    expect((await post("/shell", { command: "fixture" }, { signal })).status).toBe(408);
    expect(
      (await app.fetch(request("/files/put?path=new", source(Buffer.from("data")), signal))).status,
    ).toBe(408);
    expect(shell).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it("aborts a chunked upload without committing partial bytes", async () => {
    const { app, home } = setup();
    const abort = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.from("partial"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = app.fetch(request("/files/put?path=new", stream, abort.signal));
    await Promise.resolve();
    abort.abort();
    expect((await response).status).toBe(408);
    expect(cancelled).toBe(true);
    expect(readdirSync(home)).toEqual([]);
  });

  it("returns raw downloads as attachment streams and enforces the fetch cap", async () => {
    const { app, home } = setup({ maxFetchBytes: 4 });
    writeFileSync(join(home, "file"), "abcd");
    const response = await app.request("/files/fetch?path=file", { headers: auth });
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(await response.text()).toBe("abcd");
    writeFileSync(join(home, "file"), "abcde");
    expect((await app.request("/files/fetch?path=file", { headers: auth })).status).toBe(413);
  });
});
