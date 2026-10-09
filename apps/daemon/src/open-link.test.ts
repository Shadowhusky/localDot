import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import type { EventLog } from "./event-log.ts";
import { InstallCodes } from "./install-codes.ts";
import { runOpenLink } from "./open-link.ts";
import { terminalQr } from "./terminal-qr.ts";

const TOKEN = "t".repeat(43),
  CODE = "c".repeat(43),
  PORT = 4750;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "localdot-install-link-test-"));
  chmodSync(home, 0o700);
  writeFileSync(join(home, "daemon-token"), `${TOKEN}\n`, { mode: 0o600 });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
});
function fixture(
  fetch: typeof globalThis.fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(json({ code: CODE, expiresAt: Date.now() + 60_000 })),
) {
  const abort = new AbortController(),
    out = vi.fn(),
    err = vi.fn();
  return {
    abort,
    out,
    err,
    fetch,
    run: () => runOpenLink({ home, port: PORT, signal: abort.signal }, { out, err, fetch }),
  };
}

describe("fresh local sign-in link", () => {
  it("uses existing private authority to issue and redeem a real one-use link in process", async () => {
    const codes = new InstallCodes(TOKEN, PORT);
    const app = createApp({
      token: TOKEN,
      port: PORT,
      installCodes: codes,
      eventLog: {} as EventLog,
    });
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => app.request(String(input), init));
    const f = fixture(request);
    expect(await f.run()).toBe(0);
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe(`http://127.0.0.1:${PORT}/api/install-code`);
    expect(options).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const printed = String(f.out.mock.calls[0]?.[0]);
    expect(printed).not.toContain(TOKEN);
    const code = new URLSearchParams(new URL(printed).hash.slice(1)).get("code");
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const exchange = () =>
      app.request(`http://127.0.0.1:${PORT}/auth/exchange-code`, {
        method: "POST",
        headers: { origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
    expect(await (await exchange()).json()).toEqual({ token: TOKEN });
    expect((await exchange()).status).toBe(401);
    expect(readFileSync(join(home, "daemon-token"), "utf8")).toBe(`${TOKEN}\n`);
    expect(f.err).not.toHaveBeenCalled();
  });
  it.each([401, 429, 500, 302])(
    "does not echo a %s daemon body or retry issuance",
    async (status) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(json({ secret: TOKEN }, status));
      const f = fixture(request);
      expect(await f.run()).toBe(1);
      expect(f.out).not.toHaveBeenCalled();
      expect(JSON.stringify(f.err.mock.calls)).not.toContain(TOKEN);
      expect(request).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { code: TOKEN, expiresAt: Date.now() + 60_000 },
    { code: "short", expiresAt: Date.now() + 60_000 },
    { code: CODE, expiresAt: 0 },
    { code: CODE, expiresAt: Date.now() + 120_000 },
    { code: CODE, expiresAt: Date.now() + 60_000, token: TOKEN },
  ])("rejects invalid or reusable authority in issuance replies %#", async (value) => {
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(json(value)));
    expect(await f.run()).toBe(1);
    expect(f.out).not.toHaveBeenCalled();
    expect(JSON.stringify(f.err.mock.calls)).not.toContain(TOKEN);
  });
  it("bounds response bytes and cancels oversized streams", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(257));
      },
      cancel,
    });
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
    expect(await f.run()).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.out).not.toHaveBeenCalled();
  });
  it("settles a stuck fetch at its deadline without retrying", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const f = fixture(request),
      pending = f.run();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toBe(1);
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(f.out).not.toHaveBeenCalled();
  });
  it("cancels a blocked response body on interruption without printing a link", async () => {
    const cancel = vi.fn();
    const f = fixture(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }))),
    );
    const pending = f.run();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    f.abort.abort();
    expect(await pending).toBe(130);
    expect(f.out).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("read-only private install authority", () => {
  it.each(["missing", "wide-home", "wide-token", "symlink", "hardlink", "large", "malformed"])(
    "refuses %s before any request",
    async (mode) => {
      const file = join(home, "daemon-token"),
        other = join(home, "other");
      if (mode === "missing") rmSync(file);
      if (mode === "wide-home") chmodSync(home, 0o755);
      if (mode === "wide-token") chmodSync(file, 0o644);
      if (mode === "symlink") {
        rmSync(file);
        writeFileSync(other, TOKEN, { mode: 0o600 });
        symlinkSync(other, file);
      }
      if (mode === "hardlink") linkSync(file, other);
      if (mode === "large") writeFileSync(file, "x".repeat(1025));
      if (mode === "malformed") writeFileSync(file, "invalid");
      const f = fixture();
      expect(await f.run()).toBe(1);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.out).not.toHaveBeenCalled();
      expect(JSON.stringify(f.err.mock.calls)).not.toContain(TOKEN);
    },
  );
  it("does not issue after an already interrupted invocation", async () => {
    const f = fixture();
    f.abort.abort();
    expect(await f.run()).toBe(130);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.out).not.toHaveBeenCalled();
  });
});

describe("links for other devices", () => {
  const issue = () =>
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ code: CODE, expiresAt: Date.now() + 60_000 }));
  const front = new URL("https://box.example.ts.net:4750");
  const run = (options: { publicOrigins?: URL[]; qr?: boolean }) => {
    const out = vi.fn(),
      err = vi.fn();
    const pending = runOpenLink(
      { home, port: PORT, signal: new AbortController().signal, ...options },
      { out, err, fetch: issue() },
    );
    return { out, err, pending };
  };

  it("prints the same one-use code through each HTTPS front", async () => {
    const f = run({ publicOrigins: [front] });
    expect(await f.pending).toBe(0);
    expect(f.out.mock.calls.map(([line]) => line)).toEqual([
      `http://127.0.0.1:${PORT}/#code=${CODE}`,
      `From your other devices: https://box.example.ts.net:4750/#code=${CODE}`,
    ]);
    expect(f.err).not.toHaveBeenCalled();
  });

  it("draws the front's link as a QR code for a phone", async () => {
    const f = run({ publicOrigins: [front], qr: true });
    expect(await f.pending).toBe(0);
    const printed = String(f.out.mock.calls[2]?.[0]);
    for (const line of terminalQr(`https://box.example.ts.net:4750/#code=${CODE}`) ?? [])
      expect(printed).toContain(line);
    expect(printed).not.toContain(TOKEN);
  });

  it("draws no QR code for a link only this computer can open", async () => {
    const f = run({ qr: true });
    expect(await f.pending).toBe(0);
    expect(f.out.mock.calls).toEqual([[`http://127.0.0.1:${PORT}/#code=${CODE}`]]);
    expect(String(f.err.mock.calls[0]?.[0])).toContain("No QR code");
  });
});
