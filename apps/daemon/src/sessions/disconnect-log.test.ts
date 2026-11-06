import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventStreamResponse } from "./routes.ts";

const undo: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const step of undo.splice(0).reverse()) await step();
  vi.restoreAllMocks();
});

async function server(): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "disconnect-log-"));
  undo.push(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "events.jsonl");
  const line = `${JSON.stringify({ v: 1, seq: 1, type: "heartbeat", data: { pad: "x".repeat(4000) } })}\n`;
  writeFileSync(file, line.repeat(5000));
  const app = new Hono();
  app.get("/events", (c) => eventStreamResponse(file, 0, c.req.raw.signal));
  const listening = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  await new Promise((resolve) => listening.once("listening", resolve));
  undo.push(() => new Promise<void>((resolve) => listening.close(() => resolve())));
  return (listening.address() as AddressInfo).port;
}

// The client goes away at a chosen moment: a refreshed page's requests end this way.
function leave(port: number, when: "first-byte" | "at-once"): Promise<void> {
  return new Promise((resolve) => {
    const asked = request({ host: "127.0.0.1", port, path: "/events" }, (reply) => {
      reply.once("data", () => asked.destroy());
      reply.once("close", () => resolve());
    });
    asked.on("error", () => resolve());
    asked.on("close", () => resolve());
    asked.end();
    if (when === "at-once") setImmediate(() => asked.destroy());
  });
}

describe("a client that goes away", () => {
  it("leaves nothing in the daemon's log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await server();
    for (let i = 0; i < 20; i++) await leave(port, i % 2 ? "first-byte" : "at-once");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logged.mock.calls.map(([first]) => String(first))).toEqual([]);
  });
});
