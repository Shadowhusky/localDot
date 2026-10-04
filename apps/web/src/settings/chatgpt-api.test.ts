import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import {
  ChatgptFailure,
  cancelChatgpt,
  chatgptSummary,
  installChatgpt,
  loginChatgpt,
  logoutChatgpt,
  readChatgpt,
  refreshChatgpt,
} from "./chatgpt-api.ts";

const installed = () => ({
  available: true,
  codexVersion: "0.154.0",
  state: "signed_out",
  install: { state: "ready", version: "0.154.0" },
});
const material = () => ({
  loginId: "test-attempt",
  method: "code",
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode: "TEST-DEVICE-CODE",
  startedAt: Date.now(),
});
function fixture(reply: () => Response | Promise<Response>) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const rejected = vi.fn();
  const api = createApi("fixture", {
    origin: "https://fixture.test",
    onUnauthorized: rejected,
    fetchImpl: async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        method: init?.method ?? "GET",
        body: init?.body,
      });
      return reply();
    },
  });
  return { api, calls, rejected };
}
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
describe("bounded ChatGPT account transport", () => {
  it("reads unsupported and not-installed status without installation, login or another endpoint", async () => {
    for (const available of [false, true]) {
      const f = fixture(() =>
        Response.json({
          available,
          codexVersion: "0.154.0",
          state: "unavailable",
          install: { state: "not_installed" },
        }),
      );
      expect((await readChatgpt(f.api, signal())).available).toBe(available);
      expect(f.calls).toEqual([{ method: "GET", path: "/api/agent/chatgpt", body: undefined }]);
    }
  });
  it("sends one explicit pinned install request and default device-code request", async () => {
    const f = fixture(() =>
      Response.json({ state: "downloading", receivedBytes: 4 }, { status: 202 }),
    );
    expect(await installChatgpt(f.api, signal())).toEqual({
      state: "downloading",
      receivedBytes: 4,
    });
    const g = fixture(() => Response.json(material(), { status: 202 }));
    expect((await loginChatgpt(g.api, signal())).method).toBe("code");
    expect(f.calls).toEqual([
      { method: "POST", path: "/api/agent/chatgpt/install", body: undefined },
    ]);
    expect(g.calls).toEqual([
      { method: "POST", path: "/api/agent/chatgpt/login", body: '{"method":"code"}' },
    ]);
  });
  it.each([
    "http://auth.openai.com/codex/device",
    "https://auth.openai.com.evil.test/codex/device",
    "https://auth.openai.com/codex/device?user_code=TEST",
    "https://auth.openai.com/codex/device#TEST",
    "https://user@auth.openai.com/codex/device",
    "https://auth.openai.com/oauth/authorize",
  ])(
    "rejects an unverified device URL %s without echoing its material",
    async (verificationUrl) => {
      const f = fixture(() => Response.json({ ...material(), verificationUrl }, { status: 202 }));
      const failure = await loginChatgpt(f.api, signal()).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ChatgptFailure);
      expect(String(failure)).not.toContain("TEST-DEVICE-CODE");
      expect(String(failure)).not.toContain("auth.openai.com");
    },
  );
  it("refuses browser login, unknown credential/price fields, wrong pins and inconsistent installation", async () => {
    for (const raw of [
      {
        ...installed(),
        login: {
          loginId: "browser",
          method: "browser",
          authUrl: "https://auth.openai.com/oauth/authorize?TEST",
          startedAt: 1,
        },
        state: "signing_in",
      },
      { ...installed(), accessToken: "TEST-CREDENTIAL" },
      { ...installed(), codexVersion: "0.155.0" },
      { ...installed(), install: { state: "not_installed" } },
      {
        ...installed(),
        models: [{ id: "account-model", name: "Account", isDefault: true, inputUSDPerMTok: 1 }],
      },
      {
        ...installed(),
        models: [
          { id: "account-model", name: "A", isDefault: true },
          { id: "account-model", name: "B", isDefault: false },
        ],
      },
    ]) {
      const f = fixture(() => Response.json(raw));
      await expect(readChatgpt(f.api, signal())).rejects.toBeInstanceOf(ChatgptFailure);
      expect(f.calls).toHaveLength(1);
    }
  });
  it("copies only public metadata into a summary and keeps missing usage unknown", async () => {
    const f = fixture(() =>
      Response.json({
        ...installed(),
        state: "signing_in",
        login: material(),
        reason: "TEST-DIAGNOSTIC",
        lastError: "TEST-ERROR",
      }),
    );
    const summary = chatgptSummary(await readChatgpt(f.api, signal()));
    const text = JSON.stringify(summary);
    expect(text).not.toMatch(/TEST-DEVICE-CODE|auth.openai.com|TEST-DIAGNOSTIC|TEST-ERROR/);
    expect(summary.login).toEqual({ loginId: "test-attempt", startedAt: expect.any(Number) });
    expect(summary.usage).toBeUndefined();
  });
  it("bounds bodies and rejects malformed UTF-8 instead of trusting response.json", async () => {
    for (const reply of [
      new Response(new Uint8Array([0xc3, 0x28])),
      new Response("x".repeat(65537)),
      new Response("{broken"),
    ]) {
      const f = fixture(() => reply);
      await expect(readChatgpt(f.api, signal())).rejects.toBeInstanceOf(ChatgptFailure);
    }
  });
  it("classifies a retirement failure as uncertain, hides its body and retires authorization on 401", async () => {
    const f = fixture(() => new Response("TEST-DEVICE-CODE https://bad.test", { status: 503 }));
    const failure = await refreshChatgpt(f.api, signal()).catch((e: unknown) => e);
    expect(failure).toMatchObject({ uncertain: true, status: 503 });
    expect(String(failure)).toContain("blocked");
    expect(String(failure)).not.toMatch(/TEST-DEVICE-CODE|bad.test/);
    const g = fixture(() => new Response(null, { status: 401 }));
    await expect(readChatgpt(g.api, signal())).rejects.toMatchObject({ status: 401 });
    expect(g.rejected).toHaveBeenCalledOnce();
  });
  it("requires empty, positively verified cancel/logout acknowledgements", async () => {
    const f = fixture(() => new Response(null, { status: 204 }));
    await cancelChatgpt(f.api, "login", signal());
    await cancelChatgpt(f.api, "install", signal());
    await logoutChatgpt(f.api, signal());
    expect(f.calls.map((row) => [row.path, row.body])).toEqual([
      ["/api/agent/chatgpt/login/cancel", undefined],
      ["/api/agent/chatgpt/install/cancel", undefined],
      ["/api/agent/chatgpt/logout", undefined],
    ]);
    const g = fixture(() => Response.json({}, { status: 200 }));
    await expect(logoutChatgpt(g.api, signal())).rejects.toMatchObject({ uncertain: true });
  });
  it("ends a request even when fetch ignores abort and cancels a late body", async () => {
    const held = Promise.withResolvers<Response>(),
      cancel = vi.fn();
    const f = fixture(() => held.promise),
      abort = new AbortController();
    const request = readChatgpt(f.api, abort.signal);
    abort.abort();
    await expect(request).rejects.toBeInstanceOf(ChatgptFailure);
    held.resolve(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("does not wait indefinitely for an untrusted stream cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("x".repeat(65537)));
      },
      cancel,
    });
    const f = fixture(() => new Response(stream));
    await expect(readChatgpt(f.api, signal())).rejects.toBeInstanceOf(ChatgptFailure);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
