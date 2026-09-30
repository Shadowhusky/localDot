import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { EventDraft, LocalDotEvent } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type ClientOptions, WebSocket } from "ws";
import { createApp } from "./app.ts";
import { EventLog } from "./event-log.ts";
import { attachEventStream, WS_PROTOCOL } from "./event-stream.ts";
import { WS_TOKEN_PREFIX } from "./guard.ts";

const TOKEN = "s".repeat(43);
const TOKEN_PROTOCOL = `${WS_TOKEN_PREFIX}${TOKEN}`;
const thinking: EventDraft = { type: "agent.state", agent: "main", data: { state: "thinking" } };
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

let stop: (() => void) | undefined;
afterEach(() => stop?.());

async function start() {
  const port = await freePort();
  const eventLog = new EventLog(mkdtempSync(join(tmpdir(), "local dot's stream-")));
  const server = serve({
    fetch: createApp({ token: TOKEN, port, eventLog }).fetch,
    hostname: "127.0.0.1",
    port,
  });
  attachEventStream(server as Server, { port, token: TOKEN, eventLog });
  await new Promise((r) => server.once("listening", r));
  stop = () => {
    server.close();
    eventLog.close();
  };
  const origin = `http://127.0.0.1:${port}`;
  const open = (path: string, protocols: string[], options: ClientOptions = { origin }) =>
    new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, options);
  return { port, eventLog, origin, open };
}

const rawUpgrade = (port: number, target: string) =>
  new Promise<{ socket: Socket; status: string }>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("data", (chunk) => {
      const [status = ""] = String(chunk).split("\r\n");
      resolve({ socket, status });
    });
    socket.write(
      [
        `GET ${target} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        `Authorization: Bearer ${TOKEN}`,
        "",
        "",
      ].join("\r\n"),
    );
  });

const opens = (ws: WebSocket) =>
  new Promise<boolean>((resolve) => {
    ws.on("open", () => {
      ws.close();
      resolve(true);
    });
    ws.on("error", () => resolve(false));
  });

describe("event stream", () => {
  it("sends the backlog from fromSeq, then live events in order", async () => {
    const { eventLog, open } = await start();
    const id = eventLog.createSession();
    eventLog.append(id, thinking);
    eventLog.append(id, thinking);
    const ws = open(`/api/sessions/${id}/stream?fromSeq=1`, [WS_PROTOCOL, TOKEN_PROTOCOL]);
    const got: number[] = [];
    await new Promise<void>((resolve) => {
      ws.on("message", (raw) => {
        got.push((JSON.parse(String(raw)) as LocalDotEvent).seq);
        if (got.length === 1) eventLog.append(id, thinking);
        if (got.length === 2) resolve();
      });
    });
    ws.close();
    expect(got).toEqual([1, 2]);
  });

  it("selects localdot.v1 and never echoes the token subprotocol", async () => {
    const { eventLog, open } = await start();
    const id = eventLog.createSession();
    const ws = open(`/api/sessions/${id}/stream`, [TOKEN_PROTOCOL, WS_PROTOCOL]);
    expect(await opens(ws)).toBe(true);
    expect(ws.protocol).toBe(WS_PROTOCOL);
  });

  it("accepts a non-browser client with a bearer header and no origin", async () => {
    const { eventLog, open } = await start();
    const id = eventLog.createSession();
    const ws = open(`/api/sessions/${id}/stream`, [], {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await opens(ws)).toBe(true);
    expect(ws.protocol).toBe("");
  });

  it("refuses upgrades without the token, from a foreign origin or a foreign host", async () => {
    const { eventLog, origin, open } = await start();
    const path = `/api/sessions/${eventLog.createSession()}/stream`;
    const both = [WS_PROTOCOL, TOKEN_PROTOCOL];
    expect(await opens(open(path, both))).toBe(true);
    expect(await opens(open(path, [WS_PROTOCOL]))).toBe(false);
    expect(await opens(open(path, [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${"x".repeat(43)}`]))).toBe(
      false,
    );
    expect(await opens(open(path, both, { origin: "http://evil.com" }))).toBe(false);
    expect(await opens(open(path, both, { origin: "null" }))).toBe(false);
    expect(await opens(open(path, both, { origin, headers: { host: "evil.com" } }))).toBe(false);
  });

  it("refuses a traversal session id", async () => {
    const { eventLog, open } = await start();
    const both = [WS_PROTOCOL, TOKEN_PROTOCOL];
    expect(await opens(open(`/api/sessions/${eventLog.createSession()}/stream`, both))).toBe(true);
    expect(await opens(open("/api/sessions/..%2F..%2Fetc/stream", both))).toBe(false);
    expect(await opens(open("/api/sessions/01j9zq3v8y7x6w5t4s3r2q1p0n/stream", both))).toBe(false);
  });

  it("refuses an absolute-form target naming a foreign host", async () => {
    const { port, eventLog } = await start();
    const target = `http://evil.com/api/sessions/${eventLog.createSession()}/stream`;
    const { socket, status } = await rawUpgrade(port, target);
    socket.destroy();
    expect(status).toBe("HTTP/1.1 403 Forbidden");
  });

  it("survives a malformed frame from an authorized client", async () => {
    const { port, eventLog, open } = await start();
    const path = `/api/sessions/${eventLog.createSession()}/stream`;
    const { socket, status } = await rawUpgrade(port, path);
    expect(status).toBe("HTTP/1.1 101 Switching Protocols");
    // Clients must mask every frame; an unmasked one makes the server's socket emit an error.
    socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await new Promise((resolve) => socket.once("close", resolve));
    expect(await opens(open(path, [WS_PROTOCOL, TOKEN_PROTOCOL]))).toBe(true);
  });
});
