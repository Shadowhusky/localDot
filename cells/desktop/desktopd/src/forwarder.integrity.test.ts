import { once } from "node:events";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createForwarder, type ForwarderOptions } from "./forwarder.ts";

const TOKEN = "t".repeat(43);
const BASIC = `Basic ${Buffer.from(`cell:${TOKEN}`).toString("base64")}`;
const servers: Server[] = [];
const sockets = new Set<Socket>();

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function proxy(gate: Server, options: Partial<ForwarderOptions> = {}) {
  const port = await listen(gate);
  return listen(
    createForwarder({ gate: { host: "127.0.0.1", port }, readToken: () => TOKEN, ...options }),
  );
}

function get(port: number, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; text: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "http://example.test/",
          headers,
          signal: AbortSignal.timeout(1000),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (data) => chunks.push(data));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

describe("forwarder boundary and connection lifetime", () => {
  it("strips connection-nominated headers in both directions and always supplies its own token", async () => {
    const seen: IncomingMessage["headers"][] = [];
    const gate = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, {
        Connection: "X-Private-Hop",
        "X-Private-Hop": "internal",
        "X-End-To-End": "kept",
      });
      res.end("ok");
    });
    const port = await proxy(gate);
    const res = await get(port, {
      Connection: "X-Client-Hop, Proxy-Authorization",
      "X-Client-Hop": "internal",
      "Proxy-Authorization": "Basic attacker",
    });
    expect(seen[0]?.["x-client-hop"]).toBeUndefined();
    expect(seen[0]?.["proxy-authorization"]).toBe(BASIC);
    expect(res.headers["x-private-hop"]).toBeUndefined();
    expect(res.headers["x-end-to-end"]).toBe("kept");
  });

  it("cancels a plain upstream request when its client disappears", async () => {
    const arrived = Promise.withResolvers<void>();
    let closed = false;
    const port = await proxy(
      createServer((_req, res) => {
        res.on("close", () => {
          closed = true;
        });
        arrived.resolve();
      }),
    );
    const req = request({ host: "127.0.0.1", port, path: "http://example.test/" });
    req.on("error", () => {});
    req.end();
    await arrived.promise;
    req.destroy();
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500, interval: 10 });
  });

  it("cancels a pending CONNECT when its client disappears before a tunnel opens", async () => {
    const arrived = Promise.withResolvers<void>();
    let closed = false;
    const gate = createServer();
    gate.on("connect", (_req, socket) => {
      socket.on("end", () => {
        closed = true;
      });
      socket.resume();
      arrived.resolve();
    });
    const port = await proxy(gate);
    const client = connect(port, "127.0.0.1");
    sockets.add(client);
    client.on("error", () => {});
    client.write("CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n");
    await arrived.promise;
    client.destroy();
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500, interval: 10 });
  });

  it("ends a truncated upstream response instead of hanging the client", async () => {
    const port = await proxy(
      createServer((_req, res) => {
        res.writeHead(200, { "Content-Length": "100" });
        res.write("partial", () => res.destroy());
      }),
    );
    const start = Date.now();
    await expect(get(port)).rejects.toBeInstanceOf(Error);
    expect(Date.now() - start).toBeLessThan(700);
  });

  it("fails closed when reading the token throws or produces malformed data", async () => {
    for (const readToken of [
      () => "short",
      () => {
        throw new Error("private diagnostic");
      },
    ]) {
      let calls = 0;
      const port = await proxy(
        createServer((_req, res) => {
          calls += 1;
          res.end("bad");
        }),
        { readToken },
      );
      const result = await get(port).catch(() => undefined);
      expect(result?.status).toBe(503);
      expect(result?.headers["x-localdot-reason"]).toBe("no-proxy-token");
      expect(calls).toBe(0);
    }
  });

  it("bounds HTTP and CONNECT handshakes while allowing established tunnels to stay idle", async () => {
    const gate = createServer(() => {});
    gate.on("connect", () => {});
    const port = await proxy(gate, { handshakeTimeoutMs: 40, tunnelTimeoutMs: 40 });
    expect((await get(port).catch(() => undefined))?.status).toBe(504);
    const tunnel = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        method: "CONNECT",
        path: "example.test:443",
        signal: AbortSignal.timeout(1000),
      });
      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    }).catch(() => undefined);
    expect(tunnel).toBe(504);

    const echo = createServer();
    echo.on("connect", (_req, socket) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.pipe(socket);
    });
    const echoPort = await proxy(echo, { handshakeTimeoutMs: 40 });
    const client = await new Promise<Socket>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: echoPort,
        method: "CONNECT",
        path: "example.test:443",
      });
      req.on("connect", (_res, socket: Socket) => resolve(socket));
      req.on("error", reject);
      req.end();
    });
    sockets.add(client);
    client.on("error", () => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.destroyed).toBe(false);
    client.write("still live");
    expect(((await once(client, "data"))[0] as Buffer).toString()).toBe("still live");
    client.destroy();
  });

  it("waits for keyd's answer on a held CONNECT past the request bound, naming the program's port", async () => {
    const seen: (string | undefined)[] = [];
    const gate = createServer();
    gate.on("connect", (req, socket) => {
      seen.push(req.headers["x-localdot-source"] as string | undefined);
      setTimeout(() => socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"), 150);
    });
    const port = await proxy(gate, { handshakeTimeoutMs: 40 });
    const client = connect(port, "127.0.0.1");
    sockets.add(client);
    client.on("error", () => {});
    await once(client, "connect");
    client.write("CONNECT chat.example.test:5222 HTTP/1.1\r\nHost: chat.example.test:5222\r\n\r\n");
    const [answer] = await once(client, "data");
    expect((answer as Buffer).toString()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
    expect(seen).toEqual([String(client.localPort)]);
    client.destroy();
  });

  it("reads a new token on every request", async () => {
    let token = TOKEN;
    const seen: string[] = [];
    const port = await proxy(
      createServer((req, res) => {
        seen.push(req.headers["proxy-authorization"] ?? "");
        res.end("ok");
      }),
      { readToken: () => token },
    );
    await get(port);
    token = "n".repeat(43);
    await get(port);
    expect(seen).toEqual([BASIC, `Basic ${Buffer.from(`cell:${token}`).toString("base64")}`]);
  });

  it("preserves bytes pipelined alongside both CONNECT handshakes", async () => {
    let received = "";
    const gate = createServer();
    gate.on("connect", (_req, socket, head) => {
      received += head.toString();
      socket.on("data", (data) => {
        received += data.toString();
      });
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\nup-first");
    });
    const port = await proxy(gate);
    const client = connect(port, "127.0.0.1");
    sockets.add(client);
    client.on("error", () => {});
    let answer = "";
    client.on("data", (data) => {
      answer += data.toString();
    });
    client.write("CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\ndown-first");
    await vi.waitFor(
      () => {
        expect(received).toBe("down-first");
        expect(answer).toBe("HTTP/1.1 200 Connection Established\r\n\r\nup-first");
      },
      { timeout: 500, interval: 10 },
    );
    client.destroy();
  });

  it("lets an HTTP response stream after the handshake deadline", async () => {
    const port = await proxy(
      createServer((_req, res) => {
        res.write("first");
        setTimeout(() => res.end("last"), 100);
      }),
      { handshakeTimeoutMs: 40 },
    );
    expect((await get(port)).text).toBe("firstlast");
  });

  it("refuses an unsolicited upstream protocol upgrade", async () => {
    const port = await proxy(
      createServer((_req, res) => {
        res.writeHead(101, { Connection: "upgrade", Upgrade: "websocket" });
        res.end();
      }),
    );
    const result = await get(port);
    expect(result.status).toBe(502);
    expect(result.headers["x-localdot-reason"]).toBe("upgrade-refused");
  });
});
