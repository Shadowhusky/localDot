import { once } from "node:events";
import { mkdtempSync, type ReadStream, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";

const opened = vi.hoisted(() => [] as ReadStream[]);
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
      const stream = fs.createReadStream(...args);
      opened.push(stream);
      return stream;
    },
  };
});
const TOKEN = "review-local-token-never-a-real-credential";
const homes: string[] = [];
const logs: EventLog[] = [];
async function closed(stream: ReadStream) {
  if (stream.closed) return;
  await once(stream, "close");
}
afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (stream) => {
      stream.destroy();
      await closed(stream);
    }),
  );
  for (const log of logs.splice(0)) log.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "review-event-stream-"));
  homes.push(home);
  const log = new EventLog(home);
  logs.push(log);
  const id = log.createSession("fixture");
  const event = log.append(id, {
    type: "text.progress",
    agent: "main",
    data: { count: 200, chunk: "x".repeat(200), masked: false },
  });
  // Larger than readline's queued-line limit: losing this stream cannot hide behind EOF.
  writeFileSync(
    log.logFile(id),
    Array.from({ length: 5000 }, (_, seq) => `${JSON.stringify({ ...event, seq, t: seq })}\n`).join(
      "",
    ),
  );
  const app = createApp({ token: TOKEN, port: 4790, eventLog: log });
  const request = (method: string, signal?: AbortSignal, token = TOKEN) =>
    app.request(`http://127.0.0.1:4790/api/sessions/${id}/events`, {
      method,
      signal,
      headers: { authorization: `Bearer ${token}`, accept: "application/x-ndjson" },
    });
  return { request };
}
describe("review: actual NDJSON stream ownership", () => {
  it("HEAD must not strand an opened event file behind its discarded response body", async () => {
    const { request } = setup();
    const response = await request("HEAD");
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      opened.every((stream) => stream.closed),
      "HEAD retains no event-file read owner",
    ).toBe(true);
  });
  it("GET releases the real file after EOF", async () => {
    const { request } = setup();
    const response = await request("GET");
    expect((await response.text()).trim().split("\n")).toHaveLength(5000);
    await Promise.all(opened.map(closed));
    expect(opened.length).toBe(1);
    expect(opened.every((stream) => stream.closed)).toBe(true);
  });
  it("GET cancellation and abort each release the real file", async () => {
    const { request } = setup();
    const first = await request("GET");
    const reader = first.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    await Promise.all(opened.map(closed));
    const controller = new AbortController();
    const second = await request("GET", controller.signal);
    const secondReader = second.body!.getReader();
    expect((await secondReader.read()).done).toBe(false);
    controller.abort();
    await expect(secondReader.read()).rejects.toThrow("request aborted");
    await Promise.all(opened.map(closed));
    expect(opened).toHaveLength(2);
    expect(opened.every((stream) => stream.closed)).toBe(true);
  });
  it("unauthorized HEAD and GET open no event-file stream", async () => {
    const { request } = setup();
    for (const method of ["HEAD", "GET"])
      expect((await request(method, undefined, "wrong")).status).toBe(401);
    expect(opened).toHaveLength(0);
  });
});
