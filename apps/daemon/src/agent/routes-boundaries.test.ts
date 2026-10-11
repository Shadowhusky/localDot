import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { EventLog } from "../event-log.ts";
import { TRANSFER_BYTES } from "./download.ts";
import { type AgentRoutesDeps, agentRoutes } from "./routes.ts";

const opened = vi.hoisted(() => new Set<number>());
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (String(args[0]).endsWith("/payload.bin")) opened.add(fd);
      return fd;
    },
    closeSync: (fd: number) => {
      actual.closeSync(fd);
      opened.delete(fd);
    },
  };
});
const SESSION = "01JXYZ0000000000000000SESS";
const CELL = "01JXYZ0000000000000000CE11";
const PORT = 4747;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const home = fs.mkdtempSync(join(tmpdir(), "localdot-routes-independent-"));
  const eventLog = new EventLog(home);
  const signal = new AbortController();
  const settings = vi.fn(() => ({}));
  const start = vi.fn<AgentRoutesDeps["runner"]["start"]>();
  const unused = () => {
    throw new Error("unexpected dependency access");
  };
  const deps: AgentRoutesDeps = {
    runner: { start, get: () => undefined, raiseBudget: unused },
    settings: { get: settings, put: unused },
    catalog: {
      fresh() {
        return Promise.resolve(this.get());
      },
      freshness: () => ({ stale: false, refreshing: false, refreshFailed: false }),
      get: () => undefined,
      refresh: unused,
    },
    keyd: { secrets: unused },
    memory: {
      readBoth: unused,
      undo: unused,
      entries: unused,
      notes: unused,
      addEntry: unused,
      editEntry: unused,
      deleteEntry: unused,
    },
    skills: () => [],
    desktop: unused,
    redactUserText: (text) => text,
    appendTo: unused,
    home,
  };
  const app = createApp({ token: "independent-token", port: PORT, eventLog });
  agentRoutes(app, deps);
  const out = join(home, "sessions", SESSION, "out");
  fs.mkdirSync(out, { recursive: true });
  const file = join(out, "payload.bin");
  fs.writeFileSync(file, Buffer.alloc(128 * 1024, 65));
  // writeFileSync's implementation can itself call the mock; it has closed its descriptor.
  expect(opened.size).toBe(0);
  cleanups.push(() => {
    signal.abort();
    eventLog.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(
      new Request(`http://127.0.0.1:${PORT}${path}`, {
        ...init,
        signal: signal.signal,
        headers: { authorization: "Bearer independent-token", ...init.headers },
      }),
    );
  return {
    app,
    request,
    settings,
    start,
    file,
    signal,
    path: `/api/agent/sessions/${SESSION}/files/payload.bin`,
  };
}

describe("independent Task13 route boundaries", () => {
  it("HEAD closes the descriptor of the implicitly dispatched GET response", async () => {
    const f = fixture();
    const res = await f.request(f.path, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(opened.size).toBe(0);
  });
  it("GET closes its descriptor on consumer cancellation", async () => {
    const f = fixture();
    const res = await f.request(f.path);
    expect(opened.size).toBe(1);
    await res.body?.cancel();
    expect(opened.size).toBe(0);
  });
  it("GET closes its descriptor at EOF and preserves every byte", async () => {
    const f = fixture();
    const res = await f.request(f.path);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(128 * 1024).fill(65));
    expect(opened.size).toBe(0);
  });
  it("GET closes its descriptor if the file grows above the transfer cap", async () => {
    const f = fixture();
    const res = await f.request(f.path);
    fs.truncateSync(f.file, TRANSFER_BYTES + 1);
    await expect(res.arrayBuffer()).rejects.toThrow("download interrupted");
    expect(opened.size).toBe(0);
  });
  it("actual app guards reject missing credentials, foreign host and foreign origin before routes", async () => {
    const f = fixture();
    for (const [headers, expected] of [
      [{ authorization: "" }, 401],
      [{ authorization: "Bearer wrong" }, 401],
      [{ origin: "https://foreign.invalid" }, 403],
      [{ host: "foreign.invalid" }, 403],
    ] as const) {
      const res = await f.request("/api/agent/settings", { headers });
      expect(res.status).toBe(expected);
      expect(f.settings).not.toHaveBeenCalled();
      const download = await f.request(f.path, { headers });
      expect(download.status).toBe(expected);
      expect(opened.size).toBe(0);
    }
    expect((await f.request("/api/agent/settings")).status).toBe(200);
    expect(f.settings).toHaveBeenCalledTimes(1);
  });
  it("refuses malformed UTF8 and escaped lone surrogates before task admission", async () => {
    const f = fixture();
    for (const body of [
      new Uint8Array([
        ...new TextEncoder().encode('{"task":"'),
        0xff,
        ...new TextEncoder().encode('"}'),
      ]),
      '{"task":"\\ud800"}',
      '{"task":"x\\u0000y"}',
      '{"task":"go","extra":true}',
    ]) {
      const res = await f.request(`/api/cells/${CELL}/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("invalid request body");
    }
    expect(f.start).not.toHaveBeenCalled();
  });
  it("download traversal, encoded separators and header controls cannot read outside out", async () => {
    const f = fixture();
    for (const name of [
      "..%2Fpayload.bin",
      "%2e%2e%5cpayload.bin",
      ".hidden",
      "a%0db",
      "%00payload.bin",
    ]) {
      const res = await f.request(`/api/agent/sessions/${SESSION}/files/${name}`);
      expect(res.status).toBe(404);
      expect(opened.size).toBe(0);
    }
  });
});
