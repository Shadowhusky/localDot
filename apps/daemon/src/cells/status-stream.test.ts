import type { Server } from "node:http";
import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { WS_TOKEN_PREFIX } from "../guard.ts";
import { attachUpgradeRouter, WS_PROTOCOL } from "../upgrade-router.ts";
import { cellStatusRoute, followCell } from "./status-stream.ts";
import { FakeOrchestrator } from "./testing/fake-orchestrator.ts";
import type { CellSummary } from "./types.ts";

const TOKEN = "s".repeat(43);
const PROTOCOLS = [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${TOKEN}`];
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

let stop: (() => void) | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  stop?.();
});

async function start() {
  const port = await freePort();
  const cells = new FakeOrchestrator();
  const server = serve({ fetch: new Hono().fetch, hostname: "127.0.0.1", port });
  attachUpgradeRouter(server as Server, { port, token: TOKEN }, [cellStatusRoute(cells)]);
  await new Promise((r) => server.once("listening", r));
  stop = () => server.close();
  const origin = `http://127.0.0.1:${port}`;
  const open = (path: string, protocols = PROTOCOLS) =>
    new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { origin });
  const messages = (ws: WebSocket, n: number) =>
    new Promise<CellSummary[]>((resolve) => {
      const got: CellSummary[] = [];
      ws.on("message", (data) => {
        got.push(JSON.parse(String(data)) as CellSummary);
        if (got.length === n) resolve(got);
      });
    });
  const closed = (ws: WebSocket) =>
    new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  const refused = (ws: WebSocket) =>
    new Promise<string>((resolve) => ws.on("error", (err) => resolve(err.message)));
  return { cells, open, messages, closed, refused };
}

describe("cell status socket", () => {
  it("sends the current summary, then every change, and closes after removal", async () => {
    const { cells, open, messages, closed } = await start();
    const cell = await cells.create({ scale: 2 });
    const ws = open(`/api/cells/${cell.id}/status`);
    const first = messages(ws, 1);
    await new Promise((r) => ws.once("open", r));
    expect((await first)[0]).toEqual(cell);
    const next = messages(ws, 3);
    cells.emit({ ...cell, state: "ready" });
    cells.updateStream(cell.id, { connection: "live" });
    cells.emit({ ...cell, state: "removed" });
    const got = await next;
    expect(got.map((c) => c.state)).toEqual(["ready", "ready", "removed"]);
    expect(got[1]?.stream.connection).toBe("live");
    expect(await closed(ws)).toBe(1000);
    await vi.waitFor(() => expect(cells.listeners.size).toBe(0));
  });

  it("refuses unknown cells, bad ids and missing tokens", async () => {
    const { cells, open, refused } = await start();
    expect(await refused(open("/api/cells/01JXYZ0000000000000000ABCD/status"))).toContain("404");
    expect(await refused(open("/api/cells/nope/status"))).toContain("403");
    const cell = await cells.create({ scale: 2 });
    expect(await refused(open(`/api/cells/${cell.id}/status`, [WS_PROTOCOL]))).toContain("403");
  });

  it("selects localdot.v1 and never echoes the token subprotocol", async () => {
    const { cells, open } = await start();
    const cell = await cells.create({ scale: 2 });
    const ws = open(`/api/cells/${cell.id}/status`, [`${WS_TOKEN_PREFIX}${TOKEN}`, WS_PROTOCOL]);
    await new Promise((r) => ws.once("open", r));
    expect(ws.protocol).toBe(WS_PROTOCOL);
    ws.close();
  });

  it("answers 500 to an unreadable cell record and keeps serving", async () => {
    const { cells, open, refused } = await start();
    const cell = await cells.create({ scale: 2 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(cells, "get").mockImplementationOnce(() => {
      const message = `EACCES: permission denied, open '/x/cells/${cell.id}/cell.json'`;
      throw Object.assign(new Error(message), { code: "EACCES" });
    });
    expect(await refused(open(`/api/cells/${cell.id}/status`))).toContain("500");
    expect(errors).toHaveBeenCalledOnce();
    const ws = open(`/api/cells/${cell.id}/status`);
    await new Promise((r) => ws.once("open", r));
    ws.close();
  });
});

describe("a status socket that falls behind", () => {
  it("is cut off once over 1 MiB is buffered, and stops listening", async () => {
    const cells = new FakeOrchestrator();
    const cell = await cells.create({ scale: 2 });
    const handlers = new Map<string, () => void>();
    const ws = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(() => handlers.get("close")?.()),
      on: vi.fn((event: "close" | "error", handler: () => void) => {
        handlers.set(event, handler);
      }),
    };
    followCell(ws, cells, cell);
    expect(ws.send).toHaveBeenCalledOnce();
    cells.emit({ ...cell, state: "ready" });
    expect(ws.send).toHaveBeenCalledTimes(2);

    ws.bufferedAmount = 1024 * 1024 + 1;
    cells.emit({ ...cell, state: "stopping" });
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.terminate).toHaveBeenCalledOnce();
    expect(cells.listeners.size).toBe(0);
  });
});
