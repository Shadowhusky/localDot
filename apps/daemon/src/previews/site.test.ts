import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, connect } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";
import { previewTarget } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { Route } from "./rewrite.ts";
import {
  cookieName,
  deviceHeaders,
  ENTRY_PATH,
  PreviewSite,
  type SiteOptions,
  serverHeaders,
} from "./site.ts";
import { ForwarderRefused } from "./tunnel.ts";

const FRONT = "100.91.187.75";
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  return port;
}

// A development server that echoes what reached it, with a few routes for the rewrites.
async function devServer(handle?: (req: IncomingMessage, res: ServerResponse) => boolean) {
  const seen: IncomingHttpHeaders[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req.headers);
    if (handle?.(req, res)) return;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url, method: req.method }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => {
    server.close();
    server.closeAllConnections();
  });
  return { port: (server.address() as AddressInfo).port, seen, server };
}

async function site(
  upstream: number,
  options: {
    reused?: boolean;
    now?: () => number;
    connect?: () => Promise<never>;
    ports?: number[];
    hop?: SiteOptions["hop"];
    navigateMs?: number;
  } = {},
) {
  const port = await freePort();
  const target = previewTarget(`http://localhost:${upstream}/`);
  if (!target) throw new Error("bad target");
  const preview = new PreviewSite({
    port,
    target,
    hosts: () => new Set([`${FRONT}:${port}`]),
    connect:
      options.connect ?? (async (to) => connect(Number(to.dial.split(":").at(-1)), "127.0.0.1")),
    computer: () => ({ addresses: [], ports: new Set([upstream, ...(options.ports ?? [])]) }),
    hop: options.hop ?? (() => Promise.reject(new Error("no hops here"))),
    reused: options.reused ?? false,
    now: options.now,
    navigateMs: options.navigateMs,
  });
  await preview.listen();
  closers.push(() => preview.close());
  return { preview, port, host: `${FRONT}:${port}` };
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
  body?: string,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
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
  });
}

// Signs in as a device would: the entry page's script posts the secret from the link.
async function signIn(
  port: number,
  host: string,
  secret: string,
  extra: Record<string, string> = {},
) {
  const answer = await send(
    port,
    ENTRY_PATH,
    { host, origin: `https://${host}`, "content-type": "text/plain;charset=UTF-8", ...extra },
    "POST",
    secret,
  );
  const cookie = String(answer.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
  return { answer, cookie };
}

describe("a preview's address", () => {
  it("answers only the Host names of its fronts", async () => {
    const dev = await devServer();
    const { port, host } = await site(dev.port);
    expect((await send(port, "/", { host: `evil.example:${port}` })).status).toBe(403);
    expect((await send(port, "/", { host: `127.0.0.1:${port}` })).status).toBe(403);
    expect((await send(port, "/", { host: `localhost:${port}` })).status).toBe(403);
    expect((await send(port, "/", { host })).status).toBe(401);
    expect(dev.seen).toHaveLength(0);
  });
});

describe("signing a device in", () => {
  it("serves an entry page that holds no secret and runs only its own script", async () => {
    const { port, host } = await site((await devServer()).port);
    const page = await send(port, ENTRY_PATH, { host });
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toContain(`<script defer src="${ENTRY_PATH}.js">`);
    const script = await send(port, `${ENTRY_PATH}.js`, { host });
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.body).toContain("history.replaceState");
  });

  it("trades a one-use secret for an HttpOnly, Secure, Lax cookie of this port's own", async () => {
    const dev = await devServer();
    const { preview, port, host } = await site(dev.port);
    const secret = preview.mint("/app?tab=2");
    const { answer, cookie } = await signIn(port, host, secret);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({
      next: "/app?tab=2",
      server: `localhost:${dev.port}`,
    });
    expect(answer.headers["set-cookie"]?.[0]).toMatch(
      new RegExp(`^${cookieName(port)}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Lax$`),
    );
    expect(answer.headers["clear-site-data"]).toBeUndefined();
    expect((await signIn(port, host, secret)).answer.status).toBe(401);
    const page = await send(port, "/app", { host, cookie });
    expect(page.status).toBe(200);
    expect(JSON.parse(page.body)).toEqual({ url: "/app", method: "GET" });
  });

  it("refuses a secret from another page, an expired one and a made-up one", async () => {
    let now = 1_000;
    const { preview, port, host } = await site((await devServer()).port, { now: () => now });
    const secret = preview.mint("/");
    expect(
      (
        await send(
          port,
          ENTRY_PATH,
          { host, origin: "https://evil.example", "content-type": "text/plain" },
          "POST",
          secret,
        )
      ).status,
    ).toBe(403);
    now += 121_000;
    expect((await signIn(port, host, secret)).answer.status).toBe(401);
    expect((await signIn(port, host, "x".repeat(43))).answer.status).toBe(401);
  });

  it("clears what another server stored on a reused port, once per device", async () => {
    const { preview, port, host } = await site((await devServer()).port, { reused: true });
    const first = await signIn(port, host, preview.mint("/"));
    // Not "cache": browsers walk their whole disk cache for it, seconds before the page can open.
    expect(first.answer.headers["clear-site-data"]).toBe('"storage"');
    const again = await signIn(port, host, preview.mint("/"), { cookie: first.cookie });
    expect(again.answer.headers["clear-site-data"]).toBeUndefined();
  });

  it("keeps a path that starts with two slashes on this origin", async () => {
    const { preview, port, host } = await site((await devServer()).port);
    const { answer } = await signIn(port, host, preview.mint("//evil.example/x"));
    expect(JSON.parse(answer.body)).toMatchObject({ next: "/evil.example/x" });
  });
});

describe("what the server sees", () => {
  it("is addressed to itself, without the previews' cookies or who the owner is", async () => {
    const dev = await devServer();
    const { preview, port, host } = await site(dev.port);
    const { cookie } = await signIn(port, host, preview.mint("/"));
    await send(port, "/api", {
      host,
      cookie: `${cookie}; ${cookieName(4999)}=other; theme=dark; sid=abc`,
      origin: `https://${host}`,
      referer: `https://${host}/page?x=1`,
      "x-forwarded-for": "100.64.0.9",
      "x-forwarded-proto": "https",
      "tailscale-user-login": "owner@example.com",
      "tailscale-user-name": "Owner",
      "x-app": "kept",
    });
    const seen = dev.seen.at(-1);
    expect(seen?.host).toBe(`localhost:${dev.port}`);
    expect(seen?.origin).toBe(`http://localhost:${dev.port}`);
    expect(seen?.referer).toBe(`http://localhost:${dev.port}/page?x=1`);
    expect(seen?.cookie).toBe("theme=dark; sid=abc");
    expect(seen?.["x-app"]).toBe("kept");
    for (const name of [
      "x-forwarded-for",
      "x-forwarded-proto",
      "tailscale-user-login",
      "tailscale-user-name",
    ])
      expect(seen?.[name]).toBeUndefined();
  });

  it("keeps another site's Origin and Referer as they were", () => {
    const target = previewTarget("http://localhost:5173/");
    if (!target) throw new Error("bad target");
    const headers = serverHeaders(
      {
        host: `${FRONT}:4900`,
        origin: "https://other.example",
        referer: `https://${FRONT}:4901/elsewhere`,
      },
      `${FRONT}:4900`,
      target,
    );
    expect(headers.origin).toBe("https://other.example");
    expect(headers.referer).toBe(`https://${FRONT}:4901/elsewhere`);
    expect(headers.cookie).toBeUndefined();
  });
});

describe("what the device sees", () => {
  const target = previewTarget("http://localhost:3000/");
  if (!target) throw new Error("bad target");
  const route: Route = {
    front: `${FRONT}:4900`,
    target,
    computer: { addresses: [], ports: new Set([3000, 3001]) },
  };

  it("sends redirects to the computer's servers where they open on the device", () => {
    const pairs = (location: string) => deviceHeaders(["Location", location], route, false);
    expect(pairs("http://localhost:3000/login?next=%2F#top")).toEqual([
      "Location",
      `https://${FRONT}:4900/login?next=%2F#top`,
      "Cache-Control",
      "no-cache",
    ]);
    expect(pairs("http://127.0.0.1:3000/x")[1]).toBe(`https://${FRONT}:4900/x`);
    expect(pairs("/relative")[1]).toBe("/relative");
    expect(pairs("http://localhost:3001/x")[1]).toBe(
      `https://${FRONT}:4900/__localdot/to/http/localhost/3001/x`,
    );
    expect(pairs("http://localhost:3002/x")[1]).toBe("http://localhost:3002/x");
    expect(pairs("https://accounts.example/auth")[1]).toBe("https://accounts.example/auth");
  });

  it("drops what would reach past this preview and keeps the rest as sent", () => {
    expect(
      deviceHeaders(
        [
          "Set-Cookie",
          "sid=1; Path=/",
          "Set-Cookie",
          `${cookieName(4900)}=forged; Path=/; Secure`,
          "Set-Cookie",
          "auth=2; Domain=localhost; SameSite=None",
          "Strict-Transport-Security",
          "max-age=31536000",
          "Alt-Svc",
          'h3=":443"',
          "Clear-Site-Data",
          '"cookies"',
          "Transfer-Encoding",
          "chunked",
          "Content-Security-Policy",
          "default-src 'self'",
          "Cache-Control",
          "max-age=60",
        ],
        route,
        false,
      ),
    ).toEqual([
      "Set-Cookie",
      "sid=1; Path=/",
      "Set-Cookie",
      "auth=2; SameSite=None; Secure",
      "Content-Security-Policy",
      "default-src 'self'",
      "Cache-Control",
      "max-age=60",
    ]);
  });

  it("drops the server's length and encoding from a body it rewrote", () => {
    expect(
      deviceHeaders(
        [
          "Content-Type",
          "text/html",
          "Content-Length",
          "10",
          "Content-Encoding",
          "br",
          "ETag",
          "x",
        ],
        route,
        false,
        "gzip",
      ),
    ).toEqual([
      "Content-Type",
      "text/html",
      "ETag",
      "x",
      "Content-Encoding",
      "gzip",
      "Cache-Control",
      "no-cache",
    ]);
  });

  it("passes bodies through untouched, binary included", async () => {
    const bytes = Buffer.from([0, 1, 2, 254, 255, 10, 13]);
    const dev = await devServer((req, res) => {
      if (req.url !== "/blob") return false;
      res.setHeader("content-type", "application/octet-stream");
      res.end(bytes);
      return true;
    });
    const { preview, port, host } = await site(dev.port);
    const { cookie } = await signIn(port, host, preview.mint("/"));
    const body = await new Promise<Buffer>((resolve) => {
      request({ host: "127.0.0.1", port, path: "/blob", headers: { host, cookie } }, (res) => {
        const parts: Buffer[] = [];
        res.on("data", (chunk) => parts.push(chunk));
        res.on("end", () => resolve(Buffer.concat(parts)));
      }).end();
    });
    expect(body.equals(bytes)).toBe(true);
  });

  it("explains a server that isn't answering and one localDot keeps for itself", async () => {
    const down = await site(1, {
      connect: () => Promise.reject(new ForwarderRefused("unreachable")),
    });
    const signedIn = await signIn(down.port, down.host, down.preview.mint("/"));
    const page = await send(down.port, "/", { host: down.host, cookie: signedIn.cookie });
    expect(page.status).toBe(502);
    expect(page.body).toContain("Nothing is answering at localhost:1");
    expect(page.body).toContain('<a href="">Try again</a>');
    const own = await site(1, {
      connect: () => Promise.reject(new ForwarderRefused("refused-port")),
    });
    const ownCookie = (await signIn(own.port, own.host, own.preview.mint("/"))).cookie;
    expect((await send(own.port, "/", { host: own.host, cookie: ownCookie })).status).toBe(403);
  });
});

describe("what pages name", () => {
  it("rewrites the computer's addresses in a page and keeps a compressed one compressed", async () => {
    let api = 0;
    const dev = await devServer((req, res) => {
      if (req.url !== "/") return false;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip",
      });
      res.end(
        gzipSync(
          `<a href="http://localhost:${dev.port}/about">About</a><script>fetch("http://127.0.0.1:${api}/items")</script>`,
        ),
      );
      return true;
    });
    api = (await devServer()).port;
    const { preview, port, host } = await site(dev.port, { ports: [api] });
    const { cookie } = await signIn(port, host, preview.mint("/"));
    const answer = await new Promise<{ headers: IncomingHttpHeaders; body: Buffer }>((resolve) => {
      request({ host: "127.0.0.1", port, path: "/", headers: { host, cookie } }, (res) => {
        const parts: Buffer[] = [];
        res.on("data", (chunk) => parts.push(chunk));
        res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(parts) }));
      }).end();
    });
    expect(answer.headers["content-encoding"]).toBe("gzip");
    expect(answer.headers["content-length"]).toBeUndefined();
    expect(gunzipSync(answer.body).toString()).toBe(
      `<a href="https://${host}/about">About</a><script>fetch("https://${host}/__localdot/to/http/127.0.0.1/${api}/items")</script>`,
    );
  });
});

describe("a slow page", () => {
  it("is cut off with what to do, while a page's own requests may take as long as they need", async () => {
    const dev = await devServer((req) => req.url === "/slow");
    const { preview, port, host } = await site(dev.port, { navigateMs: 150 });
    const { cookie } = await signIn(port, host, preview.mint("/"));
    const page = await send(port, "/slow", {
      host,
      cookie,
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    });
    expect(page.status).toBe(504);
    expect(page.body).toContain(`localhost:${dev.port} didn't answer within`);
    expect(page.body).toContain('<a href="">Try again</a>');
    const request = send(port, "/slow", { host, cookie, "sec-fetch-mode": "cors" });
    const early = await Promise.race([
      request.then(() => "answered"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 400)),
    ]);
    expect(early).toBe("waiting");
  });

  it("never waits behind the event streams other pages hold open", async () => {
    const dev = await devServer((req, res) => {
      if (req.url !== "/events") return false;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: hello\n\n");
      return true;
    });
    const { preview, port, host } = await site(dev.port);
    const { cookie } = await signIn(port, host, preview.mint("/"));
    const streams = await Promise.all(
      Array.from(
        { length: 12 },
        () =>
          new Promise<IncomingMessage>((resolve) => {
            const req = request(
              { host: "127.0.0.1", port, path: "/events", headers: { host, cookie } },
              (res) => res.once("data", () => resolve(res)),
            );
            req.end();
            closers.push(() => req.destroy());
          }),
      ),
    );
    expect(streams).toHaveLength(12);
    const page = await send(port, "/", { host, cookie });
    expect(page.status).toBe(200);
  });
});

describe("another server in the computer", () => {
  it("answers a page's requests through the via path, as from the page's own server", async () => {
    const page = await devServer();
    const api = await devServer((req, res) => {
      if (req.url !== "/start") return false;
      res.writeHead(302, { location: "/next" });
      res.end();
      return true;
    });
    const { preview, port, host } = await site(page.port, { ports: [api.port] });
    const { cookie } = await signIn(port, host, preview.mint("/"));
    const via = `/__localdot/to/http/localhost/${api.port}`;
    const answer = await send(port, `${via}/items?x=1`, {
      host,
      cookie,
      origin: `https://${host}`,
      "sec-fetch-mode": "cors",
    });
    expect(JSON.parse(answer.body)).toEqual({ url: "/items?x=1", method: "GET" });
    expect(api.seen.at(-1)).toMatchObject({
      host: `localhost:${api.port}`,
      origin: `http://localhost:${page.port}`,
    });
    expect((await send(port, `${via}/start`, { host, cookie })).headers.location).toBe(
      `${via}/next`,
    );
    expect(page.seen).toHaveLength(0);
  });

  it("opens as a preview of its own when the device goes there, unless another site sent it", async () => {
    const page = await devServer();
    const api = await devServer();
    const hops: string[] = [];
    const { preview, port, host } = await site(page.port, {
      ports: [api.port],
      hop: async (to, from) => {
        hops.push(`${to.host}${to.path} from ${from}`);
        return `https://${FRONT}:4901/__localdot/preview#secret`;
      },
    });
    const { cookie } = await signIn(port, host, preview.mint("/"));
    const navigate = { host, cookie, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    const via = `/__localdot/to/http/localhost/${api.port}/dashboard?tab=2`;
    const answer = await send(port, via, { ...navigate, "sec-fetch-site": "same-origin" });
    expect(answer.status).toBe(303);
    expect(answer.headers.location).toBe(`https://${FRONT}:4901/__localdot/preview#secret`);
    expect(hops).toEqual([`localhost:${api.port}/dashboard?tab=2 from ${host}`]);
    expect((await send(port, via, { ...navigate, "sec-fetch-site": "cross-site" })).status).toBe(
      403,
    );
    // A form posted there reaches the server through this preview, its body with it.
    const posted = await send(port, via, navigate, "POST", "name=dot");
    expect(JSON.parse(posted.body)).toEqual({ url: "/dashboard?tab=2", method: "POST" });
    expect((await send(port, "/__localdot/to/http/example.com/80/", { host, cookie })).status).toBe(
      400,
    );
    expect(hops).toHaveLength(1);
    expect(api.seen).toHaveLength(1);
  });

  it("carries a socket to it through the via path", async () => {
    const page = await devServer();
    const api = await devServer();
    const sockets = new WebSocketServer({ server: api.server });
    closers.push(() => sockets.close());
    const origins: (string | undefined)[] = [];
    sockets.on("connection", (socket, req) => {
      origins.push(req.headers.origin);
      socket.on("message", (data) => socket.send(`api:${data}`));
    });
    const { preview, port, host } = await site(page.port, { ports: [api.port] });
    const { cookie } = await signIn(port, host, preview.mint("/"));
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/__localdot/to/http/localhost/${api.port}/ws`,
      {
        headers: { host, cookie, origin: `https://${host}` },
      },
    );
    closers.push(() => socket.terminate());
    await once(socket, "open");
    socket.send("hi");
    const [reply] = await once(socket, "message");
    expect(String(reply)).toBe("api:hi");
    expect(origins).toEqual([`http://localhost:${page.port}`]);
  });
});

describe("WebSockets", () => {
  async function hmrServer() {
    const dev = await devServer();
    const sockets = new WebSocketServer({ server: dev.server });
    const origins: (string | undefined)[] = [];
    sockets.on("connection", (socket, req) => {
      origins.push(req.headers.origin);
      socket.send(JSON.stringify({ type: "connected" }));
      socket.on("message", (data) => socket.send(`echo:${data}`));
    });
    closers.push(() => sockets.close());
    return { ...dev, origins };
  }

  it("carries a hot-reload socket both ways, as from the server's own page", async () => {
    const dev = await hmrServer();
    const { preview, port, host } = await site(dev.port);
    const { cookie } = await signIn(port, host, preview.mint("/"));
    const socket = new WebSocket(`ws://127.0.0.1:${port}/__vite_hmr`, "vite-hmr", {
      headers: { host, cookie, origin: `https://${host}` },
    });
    closers.push(() => socket.terminate());
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(String(data)));
    await once(socket, "open");
    expect(socket.protocol).toBe("vite-hmr");
    await expect.poll(() => messages).toEqual([JSON.stringify({ type: "connected" })]);
    socket.send("ping");
    await expect.poll(() => messages.at(-1)).toBe("echo:ping");
    expect(dev.origins).toEqual([`http://localhost:${dev.port}`]);
    expect(preview.idleFor()).toBe(0);
  });

  it("refuses a socket without the cookie or from another site's page", async () => {
    const dev = await hmrServer();
    const { preview, port, host } = await site(dev.port);
    const { cookie } = await signIn(port, host, preview.mint("/"));
    const refused = async (headers: Record<string, string>) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
      socket.on("error", () => {});
      const [, res] = (await once(socket, "unexpected-response")) as [
        unknown,
        { statusCode: number },
      ];
      socket.terminate();
      return res.statusCode;
    };
    expect(await refused({ host, origin: `https://${host}` })).toBe(401);
    expect(await refused({ host, cookie, origin: "https://evil.example" })).toBe(403);
    expect(await refused({ host: `evil.example:${port}`, cookie, origin: `https://${host}` })).toBe(
      403,
    );
    expect(dev.origins).toEqual([]);
  });
});

describe("closing", () => {
  it("stops answering, closes open sockets and frees its port", async () => {
    const dev = await devServer();
    const { preview, port, host } = await site(dev.port);
    const { cookie } = await signIn(port, host, preview.mint("/"));
    expect((await send(port, "/", { host, cookie })).status).toBe(200);
    preview.close();
    await expect(send(port, "/", { host, cookie })).rejects.toThrow();
    const again = createServer();
    again.listen(port, "127.0.0.1");
    await once(again, "listening");
    again.close();
  });
});
