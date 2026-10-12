import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { addToolRoutes } from "../../../../cells/desktop/desktopd/src/tools/routes.ts";
import {
  DesktopdTools,
  ShellCleanupUncertainError,
  ShellExecutionUncertainError,
} from "./tools-client.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "dot-shell-handoff-")));
  homes.push(home);
  const app = new Hono();
  addToolRoutes(app, {
    home,
    env: { PATH: process.env.PATH },
    browser: {
      read: async () => {
        throw new Error("unused");
      },
      navigate: async () => {
        throw new Error("unused");
      },
    },
  });
  const requests: string[] = [];
  const transport = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    return app.request(path, init as RequestInit);
  }) as typeof fetch;
  return {
    app,
    requests,
    transport,
    tools: new DesktopdTools({ baseUrl: "http://desktop.test", token: "fixture" }, transport),
  };
}
it("Take control stops an active command and drains its cleanup result without quarantining the computer", async () => {
  const f = fixture(),
    stop = new AbortController();
  const started = Promise.withResolvers<void>();
  const output = vi.fn(() => started.resolve());
  const work = f.tools.shell({ command: "echo ready; sleep 30" }, output, stop.signal);
  const caught = work.catch((error) => error);
  await started.promise;
  const reason = new Error("user took control");
  stop.abort(reason);
  expect(await caught).toMatchObject({ done: true, exitCode: null, signal: "SIGKILL" });
  expect(f.requests).toEqual(["/shell", "/shell/stop"]);
  expect(output).toHaveBeenCalledOnce();
  await f.tools.close();
});
it("handles cancellation before response headers arrive", async () => {
  const f = fixture(),
    stop = new AbortController(),
    release = Promise.withResolvers<void>();
  const tools = new DesktopdTools({ baseUrl: "http://desktop.test", token: "fixture" }, (async (
    url,
    init,
  ) => {
    const response = await f.transport(url, init);
    if (new URL(String(url)).pathname === "/shell") await release.promise;
    return response;
  }) as typeof fetch);
  const output = vi.fn();
  const work = tools.shell({ command: "sleep 30" }, output, stop.signal);
  const caught = work.catch((error) => error);
  await vi.waitFor(() => expect(f.requests).toContain("/shell"));
  stop.abort(new Error("control"));
  release.resolve();
  expect(await caught).toMatchObject({ done: true, exitCode: null, signal: "SIGKILL" });
  expect(output).not.toHaveBeenCalled();
  await tools.close();
  await f.tools.close();
});
it.each(["lost receipt", "failed cleanup"])(
  "does not turn %s into successful cancellation",
  async (failure) => {
    const stop = new AbortController();
    let response: ReadableStreamDefaultController<Uint8Array>;
    const tools = new DesktopdTools({ baseUrl: "http://desktop.test", token: "fixture" }, (async (
      url,
    ) => {
      if (new URL(String(url)).pathname === "/shell/stop") {
        if (failure === "failed cleanup")
          response.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ error: "cleanup", status: 500, code: "shell_cleanup_uncertain" }) +
                "\n",
            ),
          );
        response.close();
        return new Response(null, { status: 204 });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            response = controller;
          },
        }),
      );
    }) as typeof fetch);
    const work = tools.shell({ command: "sleep 30" }, () => {}, stop.signal);
    const caught = work.catch((error) => error);
    stop.abort();
    expect(await caught).toBeInstanceOf(
      failure === "failed cleanup" ? ShellCleanupUncertainError : ShellExecutionUncertainError,
    );
    await tools.close();
  },
);
it("cancellation cannot target an unregistered or malformed command identity", async () => {
  const f = fixture();
  for (const [id, status] of [
    ["not-an-id", 400],
    ["11111111-1111-4111-8111-111111111111", 404],
  ] as const) {
    const reply = await f.app.request("/shell/stop", {
      method: "POST",
      body: JSON.stringify({ id }),
      headers: { "content-type": "application/json" },
    });
    expect(reply.status).toBe(status);
  }
  await f.tools.close();
});
