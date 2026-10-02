import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeydClient } from "./client.ts";

const owned: { server: Server; dir: string }[] = [];

async function serverFor(handler: RequestListener, timeout = 1000) {
  const dir = mkdtempSync("/tmp/ld-client-");
  const path = join(dir, "admin.sock");
  const server = createServer(handler);
  owned.push({ server, dir });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  chmodSync(path, 0o600);
  return { client: new KeydClient(path, timeout), dir, path };
}

afterEach(async () => {
  for (const { server, dir } of owned.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("keyd client boundaries", () => {
  it("does not open an event stream whose signal was already aborted", async () => {
    let calls = 0;
    const { client } = await serverFor((_req, res) => {
      calls++;
      res.end();
    });
    const stop = new AbortController();
    stop.abort();
    await client.events(() => {}, stop.signal);
    expect(calls).toBe(0);
  });

  it("refuses a symlink in place of the private socket", async () => {
    let calls = 0;
    const { dir, path } = await serverFor((_req, res) => {
      calls++;
      res.end();
    });
    const linked = join(dir, "linked.sock");
    symlinkSync(path, linked);
    await expect(new KeydClient(linked).status()).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toBe(0);
  });

  it("bounds a JSON reply even when an oversized unknown field would be ignored", async () => {
    const { client } = await serverFor((_req, res) => {
      res.end(JSON.stringify({ secrets: [], padding: "x".repeat(1024 * 1024) }));
    });
    await expect(client.secrets()).rejects.toMatchObject({ code: "bad-reply" });
  });

  it("uses a whole-request deadline while a reply keeps trickling bytes", async () => {
    const { client } = await serverFor((_req, res) => {
      res.write("{");
      const interval = setInterval(() => res.write(" "), 10);
      const end = setTimeout(() => res.end('"secrets":[]}'), 300);
      res.once("close", () => {
        clearInterval(interval);
        clearTimeout(end);
      });
    }, 60);
    await expect(client.secrets()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("does not copy an unstructured backend error body into its exception", async () => {
    const canary = "canary-private-error-body";
    const { client } = await serverFor((_req, res) => {
      res.writeHead(500).end(canary);
    });
    const error = await client.status().catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "internal" });
    expect(String(error)).not.toContain(canary);
  });

  it("bounds an event line before trying to parse or discard it", async () => {
    const { client } = await serverFor((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(`${"x".repeat(64 * 1024 + 1)}\n`);
    });
    await expect(client.events(() => {}, new AbortController().signal)).rejects.toMatchObject({
      code: "bad-reply",
    });
  });

  it("bounds the event handshake", async () => {
    const { client } = await serverFor(() => {}, 40);
    const stop = new AbortController();
    const outcome = client.events(() => {}, stop.signal).catch((err: unknown) => err);
    const sentinel = setTimeout(() => stop.abort(), 300);
    try {
      expect(await outcome).toMatchObject({ code: "unavailable" });
    } finally {
      clearTimeout(sentinel);
      stop.abort();
    }
  });

  it("allows an established event stream to stay idle beyond the handshake deadline", async () => {
    const { client } = await serverFor((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.flushHeaders();
    }, 40);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 150);
    try {
      await expect(client.events(() => {}, stop.signal)).resolves.toBeUndefined();
    } finally {
      clearTimeout(timer);
      stop.abort();
    }
  });

  it("rejects a failed event consumer without throwing from the socket handler", async () => {
    const { client } = await serverFor((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(`${JSON.stringify({ type: "events.dropped", time: "t", data: { count: 1 } })}\n`);
    });
    await expect(
      client.events(() => {
        throw new Error("canary-event-handler-error");
      }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "event-handler" });
  });

  it("stops delivering the rest of a buffered batch after cancellation", async () => {
    const event = `${JSON.stringify({ type: "events.dropped", time: "t", data: { count: 1 } })}\n`;
    const { client } = await serverFor((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(event.repeat(2));
    });
    const stop = new AbortController();
    let calls = 0;
    await client.events(() => {
      calls++;
      stop.abort();
    }, stop.signal);
    expect(calls).toBe(1);
  });
});
