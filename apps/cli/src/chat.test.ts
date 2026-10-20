import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseArgs } from "./args.ts";
import { chatClient, chatOrigin, chatSnapshot, chatToken, terminalText } from "./chat.ts";

const homes: string[] = [];
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});
it("accepts terminal chat without accepting credentials or arbitrary CLI arguments", () => {
  expect(parseArgs(["chat"])).toEqual({ kind: "chat" });
  expect(parseArgs(["chat", "--token", "secret"])).toBeUndefined();
});
it.each([
  "http://example.com",
  "https://user:secret@example.com",
  "https://example.com/path",
  "https://example.com/?token=secret",
  "file:///tmp/a",
])("rejects unsafe server origin %s", (value) => expect(() => chatOrigin(value)).toThrow());
it("accepts secure remote and loopback origins", () => {
  expect(chatOrigin("https://computer.example.com")).toBe("https://computer.example.com");
  expect(chatOrigin("http://127.0.0.1:4750")).toBe("http://127.0.0.1:4750");
});
it("reads only a private regular credential file, without following symlinks", () => {
  const home = mkdtempSync(join(tmpdir(), "localdot-chat-"));
  homes.push(home);
  const file = join(home, "credential"),
    token = "t".repeat(43);
  writeFileSync(file, token, { mode: 0o600 });
  expect(chatToken(file)).toBe(token);
  chmodSync(file, 0o644);
  expect(() => chatToken(file)).toThrow();
  chmodSync(file, 0o600);
  symlinkSync(file, join(home, "link"));
  expect(() => chatToken(join(home, "link"))).toThrow();
});
it("never follows redirects with a credential and submits chat through the existing API", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ sessionId: "fixture" }, { status: 202 }));
  const call = chatClient(
    "https://computer.example.com",
    "private",
    new AbortController().signal,
    fetcher,
  );
  expect(await call("/api/cells/fixture/agent", { task: "Hello" })).toEqual({
    sessionId: "fixture",
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://computer.example.com/api/cells/fixture/agent",
    expect.objectContaining({
      method: "POST",
      redirect: "error",
      body: JSON.stringify({ task: "Hello" }),
      headers: expect.objectContaining({ authorization: "Bearer private" }),
    }),
  );
});
it("does not print server bodies that could contain credentials", async () => {
  const call = chatClient(
    "https://computer.example.com",
    "secret",
    new AbortController().signal,
    async () => new Response("secret", { status: 401 }),
  );
  await expect(call("/api/whoami")).rejects.toThrow("Access expired or was revoked");
});
it("removes terminal escape sequences and bidi overrides from model output", () => {
  expect(terminalText("Hello\x1b[2Jworld\x1b]52;c;secret\x07\u202e!\nNext")).toBe(
    "Helloworld!\nNext",
  );
});

it("uses a completed recording when a daemon restart retired its live task", async () => {
  const call = chatClient(
    "http://127.0.0.1:4750",
    "private",
    new AbortController().signal,
    async (url) =>
      String(url).endsWith("/card")
        ? Response.json({ verdict: "done", steps: 8 })
        : new Response(null, { status: 404 }),
  );
  expect(await chatSnapshot(call, "fixture")).toEqual({
    sessionId: "fixture",
    status: "ended",
    toolCalls: 8,
  });
});
it("never treats a missing or still-working recording as finished", async () => {
  const call = chatClient(
    "http://127.0.0.1:4750",
    "private",
    new AbortController().signal,
    async (url) =>
      String(url).endsWith("/card")
        ? Response.json({ verdict: "working", steps: 8 })
        : new Response(null, { status: 404 }),
  );
  await expect(chatSnapshot(call, "fixture")).rejects.toThrow("404");
});
