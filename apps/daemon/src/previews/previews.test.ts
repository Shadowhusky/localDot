import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, request, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type AddressInfo, createConnection, createServer as createTcpServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewListener } from "@localdot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createPreviewForwarder } from "../../../../cells/desktop/desktopd/src/preview-forwarder.ts";
import { type CellEndpoints, type CellSummary, NO_STREAM } from "../cells/types.ts";
import { type PreviewFronts, previewFronts } from "./fronts.ts";
import { PreviewError, Previews } from "./previews.ts";
import { REFUSED, signInApp, signInService } from "./testing/sign-in.ts";

const CELL = "01JXYZ0000000000000000CELL";
const SESSION = "01JXYZ0000000000000000TASK";
const TOKEN = "t".repeat(43);
const FRONT = "100.91.187.75";
const ASKED = `${FRONT}:4744`;
const cleanup: (() => unknown)[] = [];
// What the computer lists as listening: the servers each test starts.
const running: PreviewListener[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  running.length = 0;
});

async function listening<T extends Server | ReturnType<typeof createTcpServer>>(server: T) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => {
    server.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
  return (server.address() as AddressInfo).port;
}

// A run of free loopback ports for the previews.
async function block(size = 3) {
  for (;;) {
    const from = 20_000 + Math.floor(Math.random() * 40_000);
    const probes = Array.from({ length: size }, () => createTcpServer());
    const free = await Promise.all(
      probes.map(
        (probe, i) =>
          new Promise<boolean>((resolve) => {
            probe.once("error", () => resolve(false));
            probe.listen(from + i, "127.0.0.1", () => resolve(true));
          }),
      ),
    );
    await Promise.all(
      probes.map(
        (probe) =>
          new Promise((resolve) => (probe.listening ? probe.close(resolve) : resolve(null))),
      ),
    );
    if (free.every(Boolean)) return { from, to: from + size - 1 };
  }
}

function fakeCells() {
  const listeners = new Set<(cell: CellSummary) => void>();
  let summary: CellSummary = {
    id: CELL,
    state: "ready",
    scale: 2,
    createdAt: "2026-10-22T00:00:00.000Z",
    stream: NO_STREAM,
  };
  let preview: CellEndpoints["preview"];
  return {
    get: (id: string) => (id === CELL ? summary : undefined),
    endpoints: (id: string): CellEndpoints | undefined =>
      id === CELL && summary.state === "ready"
        ? {
            desktopd: { baseUrl: "http://127.0.0.1:1", token: TOKEN },
            stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" },
            ...(preview ? { preview } : {}),
          }
        : undefined,
    subscribe(listener: (cell: CellSummary) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: () => [summary],
    change(next: Partial<CellSummary>) {
      summary = { ...summary, ...next };
      for (const listener of listeners) listener(summary);
    },
    forwarder(port: number | undefined) {
      preview = port === undefined ? undefined : { port, token: TOKEN };
    },
  };
}

async function dot(
  options: {
    fronts?: PreviewFronts;
    listening?: () => Promise<PreviewListener[]>;
    stopListening?: (port: number) => Promise<boolean>;
    working?: boolean;
    conversation?: readonly string[];
    now?: () => number;
    idleMs?: number;
    sweepEveryMs?: number;
    checkMs?: number;
    size?: number;
  } = {},
) {
  const cells = fakeCells();
  const forwarder = createPreviewForwarder({
    token: TOKEN,
    addresses: () => ["172.20.0.11"],
    ownPorts: new Set([7700]),
    listening: options.listening ?? (async () => running),
    stopListening: options.stopListening,
  });
  cells.forwarder(await listening(forwarder));
  const served: string[] = [];
  const range = await block(options.size);
  const previews = new Previews({
    range,
    cells,
    cellOf: (id) => (id === SESSION ? CELL : undefined),
    conversation: () => options.conversation ?? [SESSION],
    working: () => options.working ?? false,
    fronts: async () => options.fronts ?? previewFronts([`https://${ASKED}`]),
    serve: {
      add: async (port) => void served.push(`add ${port}`),
      remove: async (port) => void served.push(`remove ${port}`),
      close: async () => {},
    },
    now: options.now,
    idleMs: options.idleMs,
    sweepEveryMs: options.sweepEveryMs,
    checkMs: options.checkMs,
  });
  cleanup.push(() => previews.close());
  return { previews, cells, range, served };
}

async function devServer() {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader("content-type", "text/html");
    res.end(`<p>dev ${req.url}</p>`);
  });
  const port = await listening(server);
  running.push({ address: "127.0.0.1", port, name: "node" });
  return { server, port, seen };
}

function fetchVia(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
  body?: string,
  host = "127.0.0.1",
) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = request({ host, port, path, method, headers }, (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      });
      req.on("error", reject);
      req.end(body);
    },
  );
}

// What a device does with the link: open the entry page's secret, then the app. `held` is what the
// browser already keeps for that host.
async function enter(link: string, held?: string) {
  const url = new URL(link);
  const host = url.host;
  const answer = await fetchVia(
    Number(url.port),
    url.pathname,
    { host, origin: url.origin, "content-type": "text/plain", ...(held ? { cookie: held } : {}) },
    "POST",
    url.hash.slice(1),
  );
  return {
    port: Number(url.port),
    host,
    origin: url.origin,
    next: JSON.parse(answer.body).next as string,
    cookie: String(answer.headers["set-cookie"]?.[0]).split(";")[0] ?? "",
    setCookie: String(answer.headers["set-cookie"]?.[0]),
    clears: answer.headers["clear-site-data"],
  };
}

const portOf = (opened: { open: string }) => Number(new URL(opened.open).port);

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) =>
      error instanceof PreviewError ? { status: error.status, ...error.refusal } : error,
  );

describe("opening a preview", () => {
  it("serves a server in the computer on a port of the block, signed in once", async () => {
    const dev = await devServer();
    const { previews, range } = await dot();
    const opened = await previews.open(
      SESSION,
      { url: `http://localhost:${dev.port}/app?x=1` },
      ASKED,
    );
    const link = new URL(opened.open);
    expect(link.protocol).toBe("https:");
    expect(link.hostname).toBe(FRONT);
    expect(Number(link.port)).toBe(range.from);
    expect(link.pathname).toBe("/__localdot/preview");
    expect(link.hash).toMatch(/^#[A-Za-z0-9_-]{43}$/);
    expect(opened.preview).toMatchObject({
      target: `http://localhost:${dev.port}/`,
      origin: `https://${FRONT}:${range.from}`,
    });
    const device = await enter(opened.open);
    expect(device.next).toBe("/app?x=1");
    const page = await fetchVia(device.port, device.next, {
      host: device.host,
      cookie: device.cookie,
    });
    expect(page.body).toBe("<p>dev /app?x=1</p>");
    expect(dev.seen.at(-1)?.host).toBe(`localhost:${dev.port}`);
  });

  it("carries the server's hot-reload socket through the computer's forwarder", async () => {
    const dev = await devServer();
    const sockets = new WebSocketServer({ server: dev.server });
    cleanup.push(() => sockets.close());
    sockets.on("connection", (socket) =>
      socket.on("message", (data) => socket.send(`hmr:${data}`)),
    );
    const { previews } = await dot();
    const device = await enter(
      (await previews.open(SESSION, { url: `http://127.0.0.1:${dev.port}/` }, ASKED)).open,
    );
    const socket = new WebSocket(`ws://127.0.0.1:${device.port}/`, {
      headers: { host: device.host, cookie: device.cookie, origin: `https://${device.host}` },
    });
    cleanup.push(() => socket.terminate());
    await once(socket, "open");
    socket.send("update");
    const [reply] = await once(socket, "message");
    expect(String(reply)).toBe("hmr:update");
  });

  it("keeps one preview per server and gives another server a port of its own", async () => {
    const one = await devServer();
    const two = await devServer();
    const { previews, range } = await dot();
    const a = await previews.open(SESSION, { url: `http://localhost:${one.port}/` }, ASKED);
    const again = await previews.open(SESSION, { url: `http://0.0.0.0:${one.port}/docs` }, ASKED);
    const b = await previews.open(SESSION, { url: `http://localhost:${two.port}/` }, ASKED);
    expect(again.preview.id).toBe(a.preview.id);
    expect(again.open).not.toBe(a.open);
    expect(new URL(b.open).port).toBe(String(range.from + 1));
    expect((await enter(again.open)).next).toBe("/docs");
  });

  it("skips a port something else holds and says so when the block is full", async () => {
    const dev = await devServer();
    const { previews, range } = await dot({ size: 2 });
    const squatter = createTcpServer();
    squatter.listen(range.from, "127.0.0.1");
    await once(squatter, "listening");
    cleanup.push(() => squatter.close());
    const first = await previews.open(SESSION, { url: `http://localhost:${dev.port}/` }, ASKED);
    expect(new URL(first.open).port).toBe(String(range.to));
    const other = await devServer();
    expect(
      await refusal(previews.open(SESSION, { url: `http://localhost:${other.port}/` }, ASKED)),
    ).toMatchObject({
      status: 503,
    });
  });

  it("opens only addresses in the computer", async () => {
    const { previews } = await dot();
    for (const url of [
      "http://192.168.1.4:3000/",
      "https://example.com/",
      "http://localhost.evil.test/",
    ])
      expect(await refusal(previews.open(SESSION, { url }, ASKED)), url).toMatchObject({
        status: 400,
      });
    expect(
      await refusal(previews.open(SESSION, { url: "http://172.20.0.11:5173/" }, ASKED)),
    ).toEqual({
      status: 409,
      message: "Nothing is running at 172.20.0.11:5173 in your computer. Start it, then try again.",
    });
    running.push({ address: "172.20.0.11", port: 5173 });
    const own = await previews.open(SESSION, { url: "http://172.20.0.11:5173/" }, ASKED);
    expect(own.preview.target).toBe("http://172.20.0.11:5173/");
  });

  it("opens a listening server at the scheme it speaks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "localdot-preview-tls-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ].concat(["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")]),
      { stdio: "ignore" },
    );
    const secure = createHttpsServer(
      { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
      (req, res) => res.end(`secure ${req.headers.host}`),
    );
    const tls = await listening(secure);
    const dev = await devServer();
    const { previews } = await dot({
      listening: async () => [
        { address: "127.0.0.1", port: tls },
        { address: "0.0.0.0", port: dev.port, name: "node" },
      ],
    });
    const status = await previews.status(SESSION, ASKED);
    expect(status.servers).toEqual(
      [
        { port: tls, url: `https://localhost:${tls}/` },
        { port: dev.port, url: `http://localhost:${dev.port}/`, name: "node" },
      ]
        .sort((a, b) => a.port - b.port)
        .map((server) => ({ ...server, state: "answering", seenAt: expect.any(String) })),
    );
    const opened = await previews.open(SESSION, { port: tls }, ASKED);
    expect(opened.preview.target).toBe(`https://localhost:${tls}/`);
    const device = await enter(opened.open);
    const page = await fetchVia(device.port, "/", { host: device.host, cookie: device.cookie });
    expect(page.body).toBe(`secure localhost:${tls}`);
    expect((await previews.open(SESSION, { port: dev.port }, ASKED)).preview.target).toBe(
      `http://localhost:${dev.port}/`,
    );
    expect(await refusal(previews.open(SESSION, { port: 1 }, ASKED))).toMatchObject({
      status: 409,
    });
  });
});

describe("what previews say they can do", () => {
  it("is ready with the web servers that answer in the computer, and its addresses", async () => {
    const dev = await devServer();
    let greeted = 0;
    const mail = createTcpServer((socket) => {
      greeted++;
      socket.end("220 mail ready\r\n");
    });
    const quiet = createTcpServer(() => {});
    let now = 0;
    const { previews } = await dot({
      now: () => now,
      checkMs: 300,
      listening: async () => [
        { address: "127.0.0.1", port: dev.port, name: "node" },
        { address: "::1", port: dev.port, name: "node" },
        { address: "0.0.0.0", port: await listening(mail), name: "smtpd" },
        { address: "127.0.0.1", port: await listening(quiet), name: "stuck" },
        { address: "10.1.2.3", port: 9000 },
      ],
    });
    expect(await previews.status(SESSION, ASKED)).toEqual({
      state: "ready",
      addresses: ["172.20.0.11"],
      previews: [],
      servers: [
        {
          port: dev.port,
          url: `http://localhost:${dev.port}/`,
          name: "node",
          state: "answering",
          seenAt: expect.any(String),
        },
      ],
    });
    // The check never reached the app (Node refuses its request itself); only the one read of its
    // first page's title does.
    expect(dev.seen.filter((headers) => headers["content-length"])).toEqual([]);
    // A server that speaks something else is asked once, at http and at https, and then left alone.
    now += 60_000;
    await previews.status(SESSION, ASKED);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(greeted).toBe(2);
  });

  it("names a server by its first page's title", async () => {
    const dev = createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>\n  Shop &amp; Co\n</title><p>hi</p>");
    });
    running.push({ address: "0.0.0.0", port: await listening(dev) });
    const { previews } = await dot();
    await previews.status(SESSION, ASKED);
    await expect
      .poll(async () => (await previews.status(SESSION, ASKED)).servers[0]?.title)
      .toBe("Shop & Co");
  });

  it("drops a server once it stops listening, and lists one that stops answering as such", async () => {
    let now = 1_000_000;
    let answering = true;
    const server = createTcpServer((socket) => {
      socket.on("data", () => {
        if (answering) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      });
    });
    const port = await listening(server);
    running.push({ address: "127.0.0.1", port, name: "node" });
    const { previews } = await dot({ now: () => now, checkMs: 200 });
    await previews.open(SESSION, { port }, ASKED);
    const first = await previews.status(SESSION, ASKED);
    expect(first.servers).toMatchObject([{ port, state: "answering" }]);
    expect(first.previews).toHaveLength(1);

    answering = false;
    now += 11_000;
    await previews.status(SESSION, ASKED);
    now += 1;
    await expect
      .poll(async () => (await previews.status(SESSION, ASKED)).servers)
      .toMatchObject([{ port, state: "not-answering", seenAt: new Date(1_000_000).toISOString() }]);
    now += 11 * 60_000;
    await expect.poll(async () => (await previews.status(SESSION, ASKED)).servers).toEqual([]);

    answering = true;
    running.length = 0;
    now += 11_000;
    const gone = await previews.status(SESSION, ASKED);
    expect(gone.servers).toEqual([]);
    // Its preview is no longer listed, and comes back with the server.
    expect(gone.previews).toEqual([]);
  });

  it("asks to turn the computer on, update it or set up Tailscale", async () => {
    const off = await dot();
    off.cells.change({ state: "stopped" });
    expect(await off.previews.status(SESSION, ASKED)).toMatchObject({ state: "computer-off" });
    expect(
      await refusal(off.previews.open(SESSION, { url: "http://localhost:1/" }, ASKED)),
    ).toEqual({
      status: 409,
      state: "computer-off",
      message: "Turn on your computer to open previews.",
    });

    const old = await dot();
    old.cells.forwarder(undefined);
    expect(await old.previews.status(SESSION, ASKED)).toMatchObject({
      state: "needs-update",
      message: "Update your computer to open previews.",
    });
    const silent = createTcpServer((socket) => socket.end());
    old.cells.forwarder(await listening(silent));
    expect(await old.previews.status(SESSION, ASKED)).toMatchObject({ state: "needs-update" });
    expect(
      await refusal(old.previews.open(SESSION, { url: "http://localhost:1/" }, ASKED)),
    ).toMatchObject({
      status: 409,
      state: "needs-update",
    });

    const tailless = await dot({
      fronts: previewFronts([], {
        state: "not-running",
        message: "Tailscale is off. Open Tailscale and connect, then check again.",
      }),
    });
    expect(await tailless.previews.status(SESSION, "localhost:4750")).toMatchObject({
      state: "needs-tailscale",
      message: expect.stringContaining("Tailscale is off."),
    });
    expect(
      await refusal(
        tailless.previews.open(SESSION, { url: "http://localhost:1/" }, "localhost:4750"),
      ),
    ).toMatchObject({
      status: 409,
      state: "needs-tailscale",
    });
  });

  it("doesn't know a task it can't place on a computer", async () => {
    const { previews } = await dot();
    expect(await refusal(previews.status("01JXYZ0000000000000000NONE"))).toMatchObject({
      status: 404,
    });
  });
});

describe("the block's ports", () => {
  it("gives a server back the port it had, and another the port unused longest", async () => {
    let now = 0;
    const one = await devServer();
    const two = await devServer();
    const three = await devServer();
    const { previews, range } = await dot({ now: () => now, size: 3 });
    const open = (dev: { port: number }) =>
      previews.open(SESSION, { url: `http://localhost:${dev.port}/` }, ASKED);
    const a = await open(one);
    const b = await open(two);
    now += 1_000;
    previews.stop(SESSION, b.preview.id);
    now += 1_000;
    previews.stop(SESSION, a.preview.id);
    expect(portOf(await open(three))).toBe(range.from + 2);
    const again = await open(two);
    expect(portOf(again)).toBe(range.from + 1);
    // The port served nothing else in between: nothing of another server's is left to clear.
    expect((await enter(again.open)).clears).toBeUndefined();
    expect(portOf(await open(one))).toBe(range.from);
  });

  it("takes the port of a preview whose server has gone when every port is in use", async () => {
    let now = 0;
    const one = await devServer();
    const two = await devServer();
    const { previews, range } = await dot({ now: () => now, size: 1 });
    await previews.open(SESSION, { url: `http://localhost:${one.port}/` }, ASKED);
    running.splice(0, 1);
    now += 60_000;
    await previews.status(SESSION, ASKED);
    const next = await previews.open(SESSION, { url: `http://localhost:${two.port}/` }, ASKED);
    expect(portOf(next)).toBe(range.from);
    expect((await enter(next.open)).clears).toBe('"storage"');
  });
});

describe("a web app through the computer's forwarder", () => {
  it("follows its redirects, links, requests, events and sockets, and opens its other server", async () => {
    let apiPort = 0;
    let webPort = 0;
    const origins: (string | undefined)[] = [];
    const api = createServer((req, res) => {
      origins.push(req.headers.origin);
      if (req.url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ item: `http://localhost:${apiPort}/items/1` }));
    });
    const sockets = new WebSocketServer({ server: api });
    cleanup.push(() => sockets.close());
    sockets.on("connection", (socket) =>
      socket.on("message", (data) => socket.send(`api:${data}`)),
    );
    apiPort = await listening(api);
    const web = createServer((req, res) => {
      if (req.url === "/" || req.url === "/to-api") {
        const to =
          req.url === "/" ? `http://localhost:${webPort}/home` : `http://127.0.0.1:${apiPort}/`;
        res.writeHead(302, { location: to });
        return void res.end();
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "sid=1; Domain=localhost; Path=/",
      });
      res.end(
        `<a href="http://localhost:${webPort}/about">About</a> <a target="_blank" href="http://0.0.0.0:${apiPort}/docs">API</a> <script>new WebSocket("ws://localhost:${apiPort}/live")</script>`,
      );
    });
    webPort = await listening(web);
    running.push(
      { address: "0.0.0.0", port: apiPort, name: "python3" },
      { address: "127.0.0.1", port: webPort, name: "node" },
    );
    const { previews } = await dot();
    const device = await enter((await previews.open(SESSION, { port: webPort }, ASKED)).open);
    const own = `https://${device.host}`;
    const via = `/__localdot/to/http/localhost/${apiPort}`;
    const get = (path: string, extra: Record<string, string> = {}) =>
      fetchVia(device.port, path, { host: device.host, cookie: device.cookie, ...extra });

    expect((await get("/")).headers.location).toBe(`${own}/home`);
    const home = await get("/home");
    expect(home.body).toBe(
      `<a href="${own}/about">About</a> <a target="_blank" href="${own}${via}/docs">API</a> <script>new WebSocket("wss://${device.host}${via}/live")</script>`,
    );
    expect(home.headers["set-cookie"]).toEqual(["sid=1; Path=/"]);

    const item = await get(`${via}/items`, { origin: own, "sec-fetch-mode": "cors" });
    expect(JSON.parse(item.body)).toEqual({ item: `${own}${via}/items/1` });
    // As the computer's own browser would send it from the web server's page.
    expect(origins).toEqual([`http://localhost:${webPort}`]);

    const event = await new Promise<string>((resolve) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: device.port,
          path: `${via}/events`,
          headers: { host: device.host, cookie: device.cookie, accept: "text/event-stream" },
        },
        (res) => res.once("data", (chunk: Buffer) => resolve(chunk.toString())),
      );
      req.end();
      cleanup.push(() => req.destroy());
    });
    expect(event).toBe("data: first\n\n");

    const socket = new WebSocket(`ws://127.0.0.1:${device.port}${via}/live`, {
      headers: { host: device.host, cookie: device.cookie, origin: own },
    });
    cleanup.push(() => socket.terminate());
    await once(socket, "open");
    socket.send("hi");
    expect(String((await once(socket, "message"))[0])).toBe("api:hi");

    const away = new URL((await get("/to-api")).headers.location ?? "");
    expect(away.href).toBe(`${own}/__localdot/to/http/127.0.0.1/${apiPort}/`);
    const hop = await get(away.pathname, {
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-site": "same-origin",
    });
    expect(hop.status).toBe(303);
    const other = await enter(hop.headers.location ?? "");
    expect(other.port).not.toBe(device.port);
    const there = await fetchVia(other.port, other.next, {
      host: other.host,
      cookie: other.cookie,
    });
    expect(JSON.parse(there.body)).toEqual({ item: `https://${other.host}/items/1` });
    expect((await previews.status(SESSION, ASKED)).previews).toHaveLength(2);
  });
});

// A loopback port nothing on this Mac answers on.
const freePort = async () => (await block(1)).from;

async function serviceAt(registered: () => string) {
  const port = await listening(signInService(registered));
  return `http://127.0.0.1:${port}`;
}

describe("opening a preview on this Mac at the app's own address", () => {
  it("signs in where the provider sends the browser back only to the registered address", async () => {
    const mac = await freePort();
    const registered = `http://localhost:${mac}`;
    const service = await serviceAt(() => registered);
    const app = signInApp(() => service);
    const port = await listening(app.server);
    running.push({ address: "0.0.0.0", port, name: "node" });
    const { previews } = await dot();

    // Over the tailnet the page's address is the preview's own, which the provider refuses.
    const tailnet = await enter((await previews.open(SESSION, { port }, ASKED)).open);
    const refused = await fetchVia(
      Number(new URL(service).port),
      `/user_management/authorize?client_id=client_test&redirect_uri=${encodeURIComponent(`${tailnet.origin}/callback`)}`,
      {},
    );
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body)).toEqual(REFUSED);

    const opened = await previews.open(SESSION, { port, local: mac }, ASKED);
    const link = new URL(opened.open);
    expect(link.origin).toBe(registered);
    expect(link.pathname).toBe("/__localdot/preview");
    expect(opened.preview).toMatchObject({
      target: `http://localhost:${port}/`,
      origin: registered,
      local: true,
    });
    const device = await enter(opened.open);
    expect(device.setCookie).toMatch(/; HttpOnly; SameSite=Lax$/);
    const page = await fetchVia(mac, "/", { host: device.host, cookie: device.cookie });
    expect(page.body).toContain("<title>Thema (dev)</title>");
    // The app is asked as the browser addresses it, so a server-made callback names it too.
    expect(app.seen.at(-1)?.headers.host).toBe(`localhost:${mac}`);

    const sent = await fetchVia(
      Number(new URL(service).port),
      `/user_management/authorize?client_id=client_test&redirect_uri=${encodeURIComponent(`${device.origin}/callback`)}`,
      {},
    );
    expect(sent.status).toBe(302);
    const back = new URL(sent.headers.location ?? "");
    expect(back.origin).toBe(registered);
    const callback = await fetchVia(mac, `${back.pathname}${back.search}`, {
      host: back.host,
      cookie: device.cookie,
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-site": "cross-site",
    });
    expect(callback.status).toBe(200);
    expect(app.seen.at(-1)?.url).toBe(`/callback${back.search}`);
    const code = back.searchParams.get("code");
    const traded = await fetchVia(
      Number(new URL(service).port),
      "/user_management/authenticate",
      { origin: registered, "content-type": "application/json" },
      "POST",
      JSON.stringify({ code }),
    );
    expect(JSON.parse(traded.body)).toEqual({ user: { email: "owner@thema.test" } });
  });

  it("opens without Tailscale, and lists itself as on this Mac", async () => {
    const dev = await devServer();
    const mac = await freePort();
    const { previews } = await dot({
      fronts: previewFronts([], { state: "not-running", message: "Tailscale is off." }),
    });
    const opened = await previews.open(SESSION, {
      url: `http://localhost:${dev.port}/docs`,
      local: mac,
    });
    expect(opened.open).toMatch(
      new RegExp(`^http://localhost:${mac}/__localdot/preview#[A-Za-z0-9_-]{43}$`),
    );
    expect((await enter(opened.open)).next).toBe("/docs");
    const status = await previews.status(SESSION, "localhost:4750");
    expect(status.state).toBe("needs-tailscale");
    expect(status.previews).toEqual([
      expect.objectContaining({ origin: `http://localhost:${mac}`, local: true }),
    ]);
  });

  it("sends addresses back to the Mac's own address, over http, and other servers through it", async () => {
    let webPort = 0;
    const api = createServer((_req, res) => res.end("api"));
    const apiPort = await listening(api);
    const web = createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(302, { location: `http://localhost:${webPort}/home` });
        return void res.end();
      }
      res.setHeader("content-type", "text/html");
      res.end(
        `<a href="http://127.0.0.1:${webPort}/a">a</a> <script>new WebSocket("ws://localhost:${webPort}/hmr"); fetch("http://localhost:${apiPort}/v1")</script>`,
      );
    });
    webPort = await listening(web);
    running.push(
      { address: "127.0.0.1", port: webPort, name: "node" },
      { address: "0.0.0.0", port: apiPort, name: "python3" },
    );
    const mac = await freePort();
    const { previews } = await dot();
    const device = await enter((await previews.open(SESSION, { port: webPort, local: mac })).open);
    const get = (path: string) => fetchVia(mac, path, { host: device.host, cookie: device.cookie });
    expect((await get("/")).headers.location).toBe(`http://localhost:${mac}/home`);
    expect((await get("/home")).body).toBe(
      `<a href="http://localhost:${mac}/a">a</a> <script>new WebSocket("ws://localhost:${mac}/hmr"); fetch("http://localhost:${mac}/__localdot/to/http/localhost/${apiPort}/v1")</script>`,
    );
    expect((await get(`/__localdot/to/http/localhost/${apiPort}/v1`)).body).toBe("api");
    // A page opening the other server takes it to the Mac at that server's port, which here is
    // already taken: it says so rather than taking it.
    const hop = await fetchVia(mac, `/__localdot/to/http/localhost/${apiPort}/`, {
      host: device.host,
      cookie: device.cookie,
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-site": "same-origin",
    });
    expect(hop.status).toBe(502);
    expect(hop.body).toContain(`Something on this Mac already uses localhost:${apiPort}.`);
  });

  it("answers only the device it signed in, by its own loopback address", async () => {
    const dev = await devServer();
    const sockets = new WebSocketServer({ server: dev.server });
    cleanup.push(() => sockets.close());
    sockets.on("connection", (socket) => socket.send("hello"));
    const mac = await freePort();
    const { previews } = await dot();
    const tailnet = await enter((await previews.open(SESSION, { port: dev.port }, ASKED)).open);
    const device = await enter((await previews.open(SESSION, { port: dev.port, local: mac })).open);
    expect(device.cookie.startsWith(`localdot-preview-${mac}=`)).toBe(true);

    const get = (headers: Record<string, string>) => fetchVia(mac, "/", headers);
    expect((await get({ host: `localhost:${mac}`, cookie: device.cookie })).status).toBe(200);
    expect((await get({ host: `127.0.0.1:${mac}`, cookie: device.cookie })).status).toBe(200);
    // A page that rebinds its own name to this Mac.
    expect((await get({ host: `thema.example:${mac}`, cookie: device.cookie })).status).toBe(403);
    expect((await get({ host: `localhost:${mac}` })).status).toBe(401);
    expect((await get({ host: `localhost:${mac}`, cookie: tailnet.cookie })).status).toBe(401);
    expect(
      (await fetchVia(tailnet.port, "/", { host: tailnet.host, cookie: device.cookie })).status,
    ).toBe(401);
    const seen = dev.seen.at(-1);
    expect(seen?.cookie).toBeUndefined();

    // Another server on this Mac's localhost shares its cookies, but not its sockets.
    const socketFrom = (origin: string) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${mac}/`, {
          headers: { host: `localhost:${mac}`, cookie: device.cookie, origin },
        });
        cleanup.push(() => socket.terminate());
        socket.once("message", (data) => resolve(String(data)));
        socket.once("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
        socket.once("error", () => resolve("error"));
      });
    expect(await socketFrom("http://localhost:5173")).toBe("403");
    expect(await socketFrom(`http://localhost:${mac}`)).toBe("hello");

    const lan = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address;
    if (lan)
      await expect(
        fetchVia(
          mac,
          "/",
          { host: `localhost:${mac}`, cookie: device.cookie },
          "GET",
          undefined,
          lan,
        ),
      ).rejects.toThrow();
  });

  it("keeps what this Mac's browser held for localhost out of the computer", async () => {
    const seen: (string | undefined)[] = [];
    const app = createServer((req, res) => {
      seen.push(req.headers.cookie);
      if (req.url === "/sign-in") res.setHeader("set-cookie", "sid=app; Path=/; HttpOnly");
      res.end("ok");
    });
    const port = await listening(app);
    running.push({ address: "127.0.0.1", port, name: "node" });
    const mac = await freePort();
    const { previews } = await dot();
    const held = "jupyter-session=owner; theme=light";
    const device = await enter((await previews.open(SESSION, { port, local: mac })).open, held);
    const get = (path: string, cookie: string) =>
      fetchVia(mac, path, { host: device.host, cookie });
    await get("/", `${held}; ${device.cookie}`);
    await get("/sign-in", `${held}; ${device.cookie}`);
    // The app's own cookies, from its server or its pages, reach it; the Mac's earlier ones don't.
    await get("/", `${held}; ${device.cookie}; sid=app; cart=3`);
    expect(seen).toEqual([undefined, undefined, "sid=app; cart=3"]);
  });

  it("never takes a port something on this Mac answers on, nor one of localDot's", async () => {
    const dev = await devServer();
    const { previews, range } = await dot();
    // Listening everywhere doesn't stop a narrower listener on macOS, which would take its
    // loopback traffic: what answers is asked first.
    const owners = createTcpServer((socket) => socket.end("owner's own"));
    owners.listen(0, "0.0.0.0");
    await once(owners, "listening");
    cleanup.push(() => owners.close());
    const taken = (owners.address() as AddressInfo).port;
    for (const local of [taken, dev.port])
      expect(await refusal(previews.open(SESSION, { port: dev.port, local }))).toEqual({
        status: 409,
        message: `Something on this Mac already uses localhost:${local}. Stop it, or choose another port.`,
      });
    expect(await refusal(previews.open(SESSION, { port: dev.port, local: range.from }))).toEqual({
      status: 400,
      message: `localDot keeps localhost:${range.from} for its own previews. Choose another port.`,
    });
    const answer = await new Promise<string>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: taken });
      socket.on("data", (data) => resolve(String(data)));
    });
    expect(answer).toBe("owner's own");
  });

  it("ends on Stop and gives the Mac's port back; another app there takes its place", async () => {
    const one = await devServer();
    const two = await devServer();
    const mac = await freePort();
    const { previews } = await dot();
    const first = await previews.open(SESSION, { port: one.port, local: mac });
    const second = await previews.open(SESSION, { port: two.port, local: mac });
    expect(second.preview.id).not.toBe(first.preview.id);
    expect((await previews.status(SESSION, ASKED)).previews).toEqual([
      expect.objectContaining({ id: second.preview.id }),
    ]);
    const device = await enter(second.open);
    expect((await fetchVia(mac, "/x", { host: device.host, cookie: device.cookie })).body).toBe(
      "<p>dev /x</p>",
    );
    expect(previews.stop(SESSION, second.preview.id)).toBe(true);
    await expect(fetchVia(mac, "/", { host: device.host })).rejects.toThrow();
  });
});

describe("Tailscale Serve", () => {
  const served = previewFronts([], {
    state: "served",
    origin: "https://pc.example.ts.net:4750",
    message: "",
  });

  it("is added for a preview port the daemon holds and removed on Stop", async () => {
    const dev = await devServer();
    const fake = await dot({ fronts: served });
    const opened = await fake.previews.open(
      SESSION,
      { url: `http://localhost:${dev.port}/` },
      "localhost:4750",
    );
    expect(new URL(opened.open).host).toBe(`pc.example.ts.net:${fake.range.from}`);
    expect(fake.served).toEqual([`add ${fake.range.from}`]);
    await fake.previews.open(SESSION, { url: `http://localhost:${dev.port}/` }, "localhost:4750");
    expect(fake.served).toEqual([`add ${fake.range.from}`]);
    expect(fake.previews.stop(SESSION, opened.preview.id)).toBe(true);
    expect(fake.previews.stop(SESSION, opened.preview.id)).toBe(false);
    expect(fake.served).toEqual([`add ${fake.range.from}`, `remove ${fake.range.from}`]);
  });

  it("is never used beside a front that holds the ports itself", async () => {
    const dev = await devServer();
    const fake = await dot({
      fronts: previewFronts([`https://${ASKED}`], {
        state: "served",
        origin: "https://pc.example.ts.net:4750",
        message: "",
      }),
    });
    await fake.previews.open(
      SESSION,
      { url: `http://localhost:${dev.port}/` },
      "pc.example.ts.net:4750",
    );
    expect(fake.served).toEqual([]);
  });
});

describe("when a preview ends", () => {
  it("ends on Stop, leaving the server running", async () => {
    const dev = await devServer();
    const { previews } = await dot();
    const opened = await previews.open(SESSION, { url: `http://localhost:${dev.port}/` }, ASKED);
    const port = Number(new URL(opened.open).port);
    previews.stop(SESSION, opened.preview.id);
    await expect(fetchVia(port, "/", { host: `${FRONT}:${port}` })).rejects.toThrow();
    expect((await fetchVia(dev.port, "/", {})).status).toBe(200);
    expect((await previews.status(SESSION, ASKED)).previews).toEqual([]);
  });

  it("ends when the computer stops", async () => {
    const dev = await devServer();
    const { previews, cells } = await dot();
    const device = await enter(
      (await previews.open(SESSION, { url: `http://localhost:${dev.port}/` }, ASKED)).open,
    );
    cells.change({ state: "stopping" });
    await expect(
      fetchVia(device.port, "/", { host: device.host, cookie: device.cookie }),
    ).rejects.toThrow();
  });

  it("ends after two hours with nothing open", async () => {
    let now = 0;
    const dev = await devServer();
    const { previews } = await dot({ now: () => now, sweepEveryMs: 20 });
    const opened = await previews.open(SESSION, { url: `http://localhost:${dev.port}/` }, ASKED);
    const device = await enter(opened.open);
    now += 60 * 60_000;
    await fetchVia(device.port, "/", { host: device.host, cookie: device.cookie });
    now += 90 * 60_000;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await previews.status(SESSION, ASKED)).previews).toHaveLength(1);
    now += 31 * 60_000;
    await expect.poll(async () => (await previews.status(SESSION, ASKED)).previews).toEqual([]);
  });
});

// Servers dot left running, as a computer that can say who started each lists them.
describe("what is running in the computer", () => {
  const OTHER = "01JXYZ0000000000000000OTHR";
  const HOUR = 60 * 60_000;

  async function webApp(title: string) {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<title>${title}</title>`);
    });
    return listening(server);
  }

  function reaper(start = 1_000_000) {
    const clock = { now: start };
    return { clock, now: () => clock.now };
  }
  const titles = () => new Promise((resolve) => setTimeout(resolve, 30));
  const stopInto = (stopped: number[]) => async (port: number) => {
    stopped.push(port);
    return true;
  };

  it("says which servers this conversation started, and each one's folder", async () => {
    const ours = await webApp("Shop");
    const theirs = await webApp("Blog");
    const nobodys = await webApp("Mine");
    running.push(
      { address: "127.0.0.1", port: ours, name: "node", task: SESSION, project: "~/code/shop" },
      { address: "127.0.0.1", port: theirs, name: "node", task: OTHER, project: "~/code/blog" },
      { address: "127.0.0.1", port: nobodys, name: "python3" },
    );
    const { previews } = await dot({ conversation: [SESSION] });
    const { servers } = await previews.status(SESSION, ASKED);
    expect(servers.map(({ port, here, project }) => [port, here, project])).toEqual(
      [
        [ours, true, "shop"],
        [theirs, false, "blog"],
        [nobodys, undefined, undefined],
      ].sort((a, b) => Number(a[0]) - Number(b[0])),
    );
  });

  it("marks the older copy when the same app starts again on another port", async () => {
    const first = await webApp("Shop");
    const second = await webApp("Shop");
    const base = { address: "127.0.0.1", name: "node", task: SESSION, project: "~/code/shop" };
    running.push({ ...base, port: first, started: 100 }, { ...base, port: second, started: 200 });
    const { previews } = await dot();
    await previews.status(SESSION, ASKED);
    await titles();
    const { servers } = await previews.status(SESSION, ASKED);
    expect(servers.find((server) => server.port === first)?.older).toBe(true);
    expect(servers.find((server) => server.port === second)?.older).toBeUndefined();
  });

  it("never takes an API beside its web app for an older copy of it", async () => {
    const web = await webApp("Shop");
    const api = await listening(createServer((_req, res) => res.end("{}")));
    const base = { address: "127.0.0.1", name: "node", task: SESSION, project: "~/code/shop" };
    running.push({ ...base, port: api, started: 100 }, { ...base, port: web, started: 200 });
    const { previews } = await dot();
    await previews.status(SESSION, ASKED);
    await titles();
    const { servers } = await previews.status(SESSION, ASKED);
    expect(servers.every((server) => !server.older)).toBe(true);
  });

  it("stops a server dot started once it has gone unused for the idle time", async () => {
    const port = await webApp("Shop");
    running.push({ address: "127.0.0.1", port, task: SESSION, started: 100, cpu: 10 });
    const stopped: number[] = [];
    const { clock, now } = reaper();
    const { previews } = await dot({
      now,
      idleMs: HOUR,
      stopListening: stopInto(stopped),
    });
    await previews.sweep();
    clock.now += HOUR - 1;
    await previews.sweep();
    expect(stopped).toEqual([]);
    clock.now += 1;
    await previews.sweep();
    expect(stopped).toEqual([port]);
  });

  it("leaves running what it can't say dot started", async () => {
    const port = await webApp("Mine");
    running.push({ address: "127.0.0.1", port, started: 100 });
    const stopped: number[] = [];
    const { clock, now } = reaper();
    const { previews } = await dot({
      now,
      idleMs: HOUR,
      stopListening: stopInto(stopped),
    });
    await previews.sweep();
    clock.now += 10 * HOUR;
    await previews.sweep();
    expect(stopped).toEqual([]);
  });

  it("doesn't count time while a task is at work or anything is connected", async () => {
    const port = await webApp("Shop");
    const server: PreviewListener = {
      address: "127.0.0.1",
      port,
      task: SESSION,
      started: 100,
      clients: 1,
    };
    running.push(server);
    const stopped: number[] = [];
    const { clock, now } = reaper();
    const { previews } = await dot({
      now,
      idleMs: HOUR,
      stopListening: stopInto(stopped),
    });
    await previews.sweep();
    clock.now += 3 * HOUR;
    await previews.sweep();
    expect(stopped).toEqual([]);
    // A device closed its tab: its hour starts now, not when the server started.
    server.clients = 0;
    await previews.sweep();
    clock.now += HOUR - 1;
    await previews.sweep();
    expect(stopped).toEqual([]);
    clock.now += 1;
    await previews.sweep();
    expect(stopped).toEqual([port]);
  });

  it("waits for a task at work, however long the server has gone unused", async () => {
    const port = await webApp("Shop");
    running.push({ address: "127.0.0.1", port, task: SESSION, started: 100 });
    const stopped: number[] = [];
    const { clock, now } = reaper();
    const { previews } = await dot({
      now,
      idleMs: HOUR,
      working: true,
      stopListening: stopInto(stopped),
    });
    await previews.sweep();
    clock.now += 5 * HOUR;
    await previews.sweep();
    expect(stopped).toEqual([]);
  });

  it("treats a task's servers as one app: a used web app keeps its API", async () => {
    const web = await webApp("Shop");
    const api = await listening(createServer((_req, res) => res.end("{}")));
    running.push(
      { address: "127.0.0.1", port: web, task: SESSION, started: 200, clients: 1 },
      { address: "127.0.0.1", port: api, task: SESSION, started: 100 },
    );
    const stopped: number[] = [];
    const { clock, now } = reaper();
    const { previews } = await dot({
      now,
      idleMs: HOUR,
      stopListening: stopInto(stopped),
    });
    await previews.sweep();
    clock.now += 3 * HOUR;
    await previews.sweep();
    expect(stopped).toEqual([]);
  });

  it("keeps a server that is hard at work with nobody connected", async () => {
    const port = await webApp("Render");
    const server: PreviewListener = {
      address: "127.0.0.1",
      port,
      task: SESSION,
      started: 100,
      cpu: 0,
    };
    running.push(server);
    const stopped: number[] = [];
    const { clock, now } = reaper();
    const { previews } = await dot({
      now,
      idleMs: HOUR,
      stopListening: stopInto(stopped),
    });
    await previews.sweep();
    clock.now += 2 * HOUR;
    // 100 ticks a second: half a processor for two hours.
    server.cpu = 2 * 3600 * 50;
    await previews.sweep();
    expect(stopped).toEqual([]);
  });

  it("stops the older copy at once when nothing uses it, and keeps one in use", async () => {
    const first = await webApp("Shop");
    const second = await webApp("Shop");
    const base = { address: "127.0.0.1", name: "node", task: SESSION, project: "~/code/shop" };
    const older: PreviewListener = { ...base, port: first, started: 100, clients: 1 };
    running.push(older, { ...base, port: second, started: 200 });
    const stopped: number[] = [];
    const { previews } = await dot({
      stopListening: stopInto(stopped),
    });
    await previews.status(SESSION, ASKED);
    await titles();
    await previews.sweep();
    expect(stopped).toEqual([]);
    older.clients = 0;
    await previews.sweep();
    expect(stopped).toEqual([first]);
  });

  it("stops a server on request, ends its preview, and refuses a port not listed", async () => {
    const port = await webApp("Shop");
    running.push({ address: "127.0.0.1", port, name: "node" });
    const stopped: number[] = [];
    const { previews } = await dot({
      stopListening: stopInto(stopped),
    });
    const { preview } = await previews.open(SESSION, { port }, ASKED);
    await expect(previews.stopServer(SESSION, port + 1)).rejects.toBeInstanceOf(PreviewError);
    await previews.stopServer(SESSION, port);
    expect(stopped).toEqual([port]);
    running.length = 0;
    expect((await previews.status(SESSION, ASKED)).previews).toEqual([]);
    expect(previews.stop(SESSION, preview.id)).toBe(false);
  });

  it("tells a computer too old to stop a server apart from one that couldn't", async () => {
    const port = await webApp("Shop");
    running.push({ address: "127.0.0.1", port });
    const { previews } = await dot({ stopListening: async () => false });
    await expect(previews.stopServer(SESSION, port)).rejects.toMatchObject({
      status: 409,
      refusal: { message: expect.stringContaining("couldn't stop") },
    });
  });

  it("marks a *.localhost site gone when its proxy no longer routes it", async () => {
    const routes = new Map([
      ["shop.localhost", 200],
      ["old.localhost", 404],
    ]);
    const proxy = await listening(
      createServer((req, res) => {
        const name = (req.headers.host ?? "").split(":")[0] ?? "";
        res.statusCode = routes.get(name) ?? 404;
        res.end();
      }),
    );
    running.push({ address: "127.0.0.1", port: proxy, name: "portless" });
    const { previews } = await dot();
    await previews.open(SESSION, { url: `http://shop.localhost:${proxy}/` }, ASKED);
    await previews.open(SESSION, { url: `http://old.localhost:${proxy}/` }, ASKED);
    const { previews: items } = await previews.status(SESSION, ASKED);
    const state = (name: string) => items.find((item) => item.target.includes(name))?.state;
    expect(state("shop.localhost")).toBe("answering");
    expect(state("old.localhost")).toBe("not-answering");
  });

  it("drops a *.localhost site ten minutes after it last answered, once nobody uses it", async () => {
    const proxy = await listening(createServer((_req, res) => void res.writeHead(502).end()));
    running.push({ address: "127.0.0.1", port: proxy, name: "portless" });
    const { clock, now } = reaper();
    const { previews } = await dot({ now });
    await previews.open(SESSION, { url: `http://gone.localhost:${proxy}/` }, ASKED);
    await previews.status(SESSION, ASKED);
    clock.now += 11 * 60_000;
    await previews.sweep();
    expect((await previews.status(SESSION, ASKED)).previews).toEqual([]);
  });

  it("offers what the turn started, changed or named, once it answers", async () => {
    const started = await webApp("New app");
    const looked = await webApp("Looked at");
    const edited = await webApp("Edited");
    const named = await listening(createServer((_req, res) => res.end("{}")));
    const untouched = await webApp("Untouched");
    const theirs = await webApp("Another conversation's");
    const earlier: PreviewListener[] = [
      { address: "127.0.0.1", port: looked, task: SESSION, name: "node" },
      { address: "127.0.0.1", port: edited, task: SESSION, name: "node", project: "~/code/shop" },
      { address: "127.0.0.1", port: named, task: SESSION, name: "node" },
      { address: "127.0.0.1", port: untouched, task: SESSION, name: "node" },
      { address: "127.0.0.1", port: theirs, task: OTHER, name: "node" },
    ];
    running.push(...earlier);
    const { clock, now } = reaper();
    const { previews } = await dot({ now });
    await previews.sweep();
    await titles();
    clock.now += 60_000;
    running.push({ address: "127.0.0.1", port: started, task: SESSION, name: "vite" });
    const offers = await previews.offers(SESSION, {
      startedAt: clock.now - 1000,
      reply: `Your API is at http://localhost:${named}/health`,
      navigated: [`127.0.0.1:${looked}`, `127.0.0.1:${theirs}`, "example.com"],
      changed: ["~/code/shop/src/App.tsx"],
    });
    expect(offers.map((offer) => offer.port).sort()).toEqual(
      [started, looked, edited, named].sort(),
    );
    expect(offers.find((offer) => offer.port === looked)).toMatchObject({
      title: "Looked at",
      url: `http://localhost:${looked}/`,
      name: "node",
    });
  });

  it("offers nothing that has stopped, nor on a computer that is off", async () => {
    const hung = await listening(createTcpServer(() => {}));
    running.push({ address: "127.0.0.1", port: hung, task: SESSION });
    const { previews, cells } = await dot({ checkMs: 20 });
    const turn = { startedAt: 0, reply: `http://localhost:${hung}/`, navigated: [], changed: [] };
    expect(await previews.offers(SESSION, turn)).toEqual([]);
    cells.change({ state: "stopped" });
    expect(await previews.offers(SESSION, turn)).toEqual([]);
  });

  it("sweeps on its own timer without a failure reaching the daemon", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { previews, cells } = await dot({ sweepEveryMs: 5 });
    cells.forwarder(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await previews.close();
    spy.mockRestore();
  });
});
