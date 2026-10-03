import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.ts";
import { EventLog } from "../../event-log.ts";
import { AccountError } from "./account.ts";
import { chatgptRoutes } from "./routes.ts";

const homes: string[] = [];
afterEach(() => {
  for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync("/tmp/ld11-routes-"),
    token = "t".repeat(43);
  homes.push(home);
  const status = { available: true, codexVersion: "0.154.0", state: "signed_out" as const };
  const account = {
    status: vi.fn(async () => status),
    login: vi.fn(async (method = "code") => ({ loginId: "login", method, startedAt: 0 })),
    cancelLogin: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    refresh: vi.fn(async () => status),
  };
  const app = createApp({ token, port: 4750, eventLog: new EventLog(home) });
  chatgptRoutes(app, { account });
  const send = (
    path: string,
    method = "GET",
    body?: string,
    headers: Record<string, string> = {},
  ) =>
    app.request(`http://127.0.0.1:4750/api/agent/chatgpt${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body,
    });
  return { app, account, status, send };
}
describe("authenticated ChatGPT account routes", () => {
  it("serves status and defaults explicit login to a device code", async () => {
    const f = fixture();
    expect(await (await f.send("")).json()).toEqual(f.status);
    const login = await f.send("/login", "POST", "{}");
    expect(login.status).toBe(202);
    expect(f.account.login).toHaveBeenCalledWith("code");
    expect((await f.send("/login", "POST", '{"method":"browser"}')).status).toBe(202);
    expect(f.account.login).toHaveBeenCalledWith("browser");
  });
  it.each(['{"extra":1}', '{"method":"sms"}', "null", "[]", "{invalid", '"code"'])(
    "rejects a malformed login body %s",
    async (body) => {
      const f = fixture();
      expect((await f.send("/login", "POST", body)).status).toBe(400);
      expect(f.account.login).not.toHaveBeenCalled();
    },
  );
  it("rejects oversized and non-JSON login bodies before calling the owner", async () => {
    const f = fixture();
    expect(
      (await f.send("/login", "POST", JSON.stringify({ method: "x".repeat(4096) }))).status,
    ).toBe(413);
    expect((await f.send("/login", "POST", "{}", { "content-type": "text/plain" })).status).toBe(
      415,
    );
    expect(f.account.login).not.toHaveBeenCalled();
  });
  it.each([409, 503] as const)(
    "maps a fixed AccountError %s without generic error logging",
    async (code) => {
      const f = fixture();
      f.account.login.mockRejectedValueOnce(
        new AccountError(code, "Account process could not be stopped."),
      );
      const reply = await f.send("/login", "POST", "{}");
      expect(reply.status).toBe(code);
      expect(await reply.text()).toBe("Account process could not be stopped.");
    },
  );
  it("cancels, signs out and refreshes with empty mutation bodies", async () => {
    const f = fixture();
    expect((await f.send("/login/cancel", "POST")).status).toBe(204);
    expect((await f.send("/logout", "POST")).status).toBe(204);
    expect(await (await f.send("/refresh", "POST")).json()).toEqual(f.status);
  });
  it.each(["/login/cancel", "/logout", "/refresh"])(
    "rejects an unexpected mutation body for %s",
    async (path) => {
      const f = fixture();
      expect((await f.send(path, "POST", "{}")).status).toBe(400);
      expect(f.account.cancelLogin).not.toHaveBeenCalled();
      expect(f.account.logout).not.toHaveBeenCalled();
      expect(f.account.refresh).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["", "GET"],
    ["/login", "POST"],
    ["/login/cancel", "POST"],
    ["/logout", "POST"],
    ["/refresh", "POST"],
  ])("requires the install token for %s %s", async (path, method) => {
    const f = fixture();
    expect(
      (
        await f.send(path, method, method === "POST" && path === "/login" ? "{}" : undefined, {
          authorization: "",
        })
      ).status,
    ).toBe(401);
    expect(f.account.status).not.toHaveBeenCalled();
    expect(f.account.login).not.toHaveBeenCalled();
  });
  it("consumes a canceled request even when its next body chunk never arrives", async () => {
    const f = fixture(),
      abort = new AbortController();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        controller.enqueue(new TextEncoder().encode("{"));
      },
      pull() {
        entered();
      },
    });
    const request = new Request("http://127.0.0.1:4750/api/agent/chatgpt/login", {
      method: "POST",
      body,
      duplex: "half",
      signal: abort.signal,
      headers: { authorization: `Bearer ${"t".repeat(43)}`, "content-type": "application/json" },
    } as RequestInit);
    const pending = Promise.resolve(f.app.request(request));
    await reading;
    abort.abort();
    const outcome = await Promise.race([
      pending.then(() => "ended"),
      new Promise<"unresolved">((resolve) => setTimeout(() => resolve("unresolved"), 100)),
    ]);
    try {
      bodyController?.close();
    } catch {
      /* The cancellation may already have closed it. */
    }
    await pending;
    expect(outcome).toBe("ended");
    expect(f.account.login).not.toHaveBeenCalled();
  });
  it("does not expose or log unexpected account exceptions", async () => {
    const f = fixture(),
      log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.account.login.mockRejectedValueOnce(new Error("private auth URL and credential"));
    try {
      const reply = await f.send("/login", "POST", "{}");
      expect(reply.status).toBe(503);
      expect(await reply.text()).toBe("The ChatGPT account operation failed.");
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
