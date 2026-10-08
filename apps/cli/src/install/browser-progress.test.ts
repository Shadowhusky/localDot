import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { PROGRESS_HTML } from "./browser-page.ts";
import { progressChannel } from "./browser-progress.ts";

const capability = "a".repeat(43),
  origin = "http://127.0.0.1:53321";
const target = `http://127.0.0.1:4750/#code=${"b".repeat(43)}`;
function request(
  channel: ReturnType<typeof progressChannel>,
  options: {
    url?: string;
    method?: string;
    headers?: Record<string, string | undefined>;
    omitAuth?: boolean;
  } = {},
) {
  const headers: Record<string, string> = {};
  const response = Object.assign(new EventEmitter(), {
    status: 0,
    body: "",
    setHeader(key: string, value: string) {
      headers[key] = value;
    },
    writeHead(code: number, values?: Record<string, string>) {
      this.status = code;
      Object.assign(headers, values);
    },
    end(body = "") {
      this.body = body;
      response.emit("finish");
    },
  });
  channel.handle(
    origin,
    {
      method: options.method ?? "GET",
      url: options.url ?? "/status",
      headers: {
        host: "127.0.0.1:53321",
        ...(options.omitAuth ? {} : { authorization: `Bearer ${capability}` }),
        ...options.headers,
      },
    } as IncomingMessage,
    response as unknown as ServerResponse,
  );
  return { status: response.status, body: response.body, headers };
}
it("serves an inert static page without putting the read capability or sign-in link into HTML", () => {
  const channel = progressChannel(capability, 4750);
  channel.finish("ready", target);
  const result = request(channel, { url: "/", omitAuth: true });
  expect(result.status).toBe(200);
  expect(result.body).toBe(PROGRESS_HTML);
  expect(result.body).not.toContain(capability);
  expect(result.body).not.toContain(target);
  expect(result.headers["Cache-Control"]).toBe("no-store");
  expect(result.headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  expect(result.headers["Content-Security-Policy"]).not.toContain("unsafe-inline");
  expect(result.headers["Referrer-Policy"]).toBe("no-referrer");
  expect(result.headers).not.toHaveProperty("Access-Control-Allow-Origin");
});
it.each([
  { omitAuth: true },
  { headers: { authorization: `Bearer ${"c".repeat(43)}` } },
  { headers: { authorization: "short" } },
  { headers: { host: "localhost:53321" } },
  { headers: { host: "attacker.example:53321" } },
  { headers: { origin: "https://attacker.example" } },
  { headers: { "sec-fetch-site": "cross-site" } },
  { headers: { "sec-fetch-site": "same-site" } },
  { method: "POST" },
  { method: "HEAD" },
  { method: "OPTIONS" },
  { url: "/status?token=ignored" },
  { url: "/api/install-code" },
  { headers: { "content-length": "1" } },
  { headers: { "transfer-encoding": "chunked" } },
])("refuses a foreign or malformed status request without disclosing progress: %j", (options) => {
  const channel = progressChannel(capability, 4750);
  channel.finish("ready", target);
  const result = request(channel, options);
  expect(result.status).toBe(404);
  expect(result.body).toBe("");
});
it("returns only fixed progress and bounded counters, never layer names or raw fields", () => {
  const channel = progressChannel(capability, 4750);
  expect(JSON.parse(request(channel).body)).toEqual({ phase: "release" });
  channel.report({
    role: "desktop",
    phase: "downloading",
    layer: "private-secret",
    currentBytes: 10,
    totalBytes: 20,
  });
  expect(JSON.parse(request(channel).body)).toEqual({
    phase: "images",
    role: "desktop",
    imagePhase: "downloading",
    currentBytes: 10,
    totalBytes: 20,
  });
  channel.report({ role: "desktop", phase: "extracting", currentBytes: Infinity, totalBytes: 20 });
  expect(JSON.parse(request(channel).body)).toEqual({
    phase: "images",
    role: "desktop",
    imagePhase: "extracting",
  });
  channel.starting();
  expect(JSON.parse(request(channel).body)).toEqual({ phase: "starting" });
});
it("only completes after valid exact-port sign-in and ignores progress after completion", async () => {
  const channel = progressChannel(capability, 4750);
  let delivered = false;
  void channel.delivered.then(() => {
    delivered = true;
  });
  request(channel);
  await Promise.resolve();
  expect(delivered).toBe(false);
  for (const url of [
    target.replace(":4750", ":4751"),
    target.replace("127.0.0.1", "evil.example"),
    target.replace("#code", "#progress"),
    `${target}&x=1`,
    "file:///tmp/page.html",
  ])
    expect(() => channel.finish("ready", url)).toThrow("Invalid setup destination");
  expect(JSON.parse(request(channel).body)).toEqual({ phase: "release" });
  channel.finish("ready", target);
  channel.report({ role: "gate", phase: "checking" });
  channel.starting();
  channel.finish("failed");
  expect(
    JSON.parse(request(channel, { headers: { origin, "sec-fetch-site": "same-origin" } }).body),
  ).toEqual({ phase: "ready", url: target });
  await channel.delivered;
  expect(delivered).toBe(true);
});
it.each(["failed", "cancelled"] as const)("reports %s without a sign-in URL", (phase) => {
  const channel = progressChannel(capability, 4750);
  channel.finish(phase);
  expect(JSON.parse(request(channel).body)).toEqual({ phase });
});
