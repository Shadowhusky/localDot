import { gzipSync, zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { fakeAuthJson, fakeTokens, type OpenAiMock, startOpenAiMock } from "./openai-mock.ts";

const fixtures: OpenAiMock[] = [];
afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.close();
});
async function fixture() {
  const h = await startOpenAiMock();
  fixtures.push(h);
  return h;
}
describe("bounded local subscription stand-in", () => {
  it("uses unsigned fixture identities and rotates their inert tokens", () => {
    const token = fakeTokens(2, 60);
    const claims = JSON.parse(
      Buffer.from(token.access_token.split(".")[1] ?? "", "base64url").toString(),
    );
    expect(claims.n).toBe(2);
    expect(claims["https://api.openai.com/auth"].chatgpt_account_id).toBe("acct-test");
    expect(JSON.parse(fakeAuthJson()).auth_mode).toBe("chatgpt");
    expect(token.refresh_token).toBe("rt-2");
  });
  it.each(["identity", "gzip", "zstd"])(
    "records actual %s request bodies and emits bounded SSE replies",
    async (encoding) => {
      const h = await fixture(),
        raw = Buffer.from(JSON.stringify({ model: "fixture", store: false, input: [] }));
      const encoded =
        encoding === "gzip" ? gzipSync(raw) : encoding === "zstd" ? zstdCompressSync(raw) : raw;
      const response = await fetch(`${h.base}/backend-api/codex/responses`, {
        method: "POST",
        headers: {
          "content-encoding": encoding,
          "content-type": "application/json",
          authorization: "Bearer fixture",
        },
        body: encoded,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(await response.text()).toContain("response.completed");
      expect(h.responses).toEqual([{ model: "fixture", store: false, input: [] }]);
      expect(h.requests[0]).toMatchObject({
        method: "POST",
        path: "/backend-api/codex/responses",
        auth: "Bearer fixture",
      });
      expect(h.errors).toEqual([]);
    },
  );
  it("never redirects unknown endpoints and separately records refresh failure", async () => {
    const h = await fixture();
    const denied = await fetch(`${h.base}/foreign/plugin`);
    expect(denied.status).toBe(404);
    expect(denied.headers.get("location")).toBeNull();
    h.refreshFails = true;
    expect(
      (await fetch(`${h.base}/oauth/token`, { method: "POST", body: "grant_type=refresh_token" }))
        .status,
    ).toBe(401);
    h.refreshFails = false;
    const response = await fetch(`${h.base}/oauth/token`, {
      method: "POST",
      body: "grant_type=refresh_token",
    });
    expect(((await response.json()) as { refresh_token: string }).refresh_token).toBe("rt-2");
    expect(h.requests.map((r) => r.path)).toEqual([
      "/foreign/plugin",
      "/oauth/token",
      "/oauth/token",
    ]);
  });
  it("rejects malformed and oversized decoded bodies and exposes fixture hook failures", async () => {
    const h = await startOpenAiMock(() => {
      throw new Error("fixture answer failed");
    });
    fixtures.push(h);
    expect(
      (await fetch(`${h.base}/backend-api/codex/responses`, { method: "POST", body: "{" })).status,
    ).toBe(400);
    const large = gzipSync(Buffer.alloc(2 * 1024 * 1024, 65));
    expect(
      (
        await fetch(`${h.base}/backend-api/codex/responses`, {
          method: "POST",
          headers: { "content-encoding": "gzip" },
          body: large,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await fetch(`${h.base}/backend-api/codex/responses`, {
          method: "POST",
          body: JSON.stringify({ input: [] }),
        })
      ).status,
    ).toBe(500);
    expect(h.errors).toContain("fixture answer failed");
  });
  it("closes owned sockets and is idempotent", async () => {
    const h = await fixture();
    await h.close();
    await h.close();
    await expect(fetch(h.base)).rejects.toThrow();
  });
});
