import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createForwarder, readTokenFile } from "./forwarder.ts";

const TOKEN = "j6CLzsRw79yMKkRwPznckks1fdcXOOnPN3DYp3Al_gk";
const BASIC = `Basic ${Buffer.from(`cell:${TOKEN}`).toString("base64")}`;

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  host: string | undefined;
}

// Stands in for gate → keyd: the cell's listener answers 407 without the cell's token, refuses
// refused.example with keyd's reason header, echoes plain requests and echoes tunnelled bytes.
async function fakeGate(): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers["proxy-authorization"],
        host: req.headers.host,
      });
      if (req.headers["proxy-authorization"] !== BASIC) {
        res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="localdot-keyd"' });
        return res.end();
      }
      if ((req.url ?? "").includes("refused.example")) {
        res.writeHead(403, { "X-Keyd-Reason": "host-denied" });
        return res.end("refused");
      }
      res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
      res.end(JSON.stringify({ url: req.url, body, cookie: req.headers.cookie ?? null }));
    });
  });
  server.on("connect", (req: IncomingMessage, socket: Socket) => {
    seen.push({
      method: "CONNECT",
      url: req.url ?? "",
      auth: req.headers["proxy-authorization"],
      host: req.headers.host,
    });
    if (req.headers["proxy-authorization"] !== BASIC) {
      return socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="localdot-keyd"\r\n\r\n',
      );
    }
    if ((req.url ?? "").startsWith("refused.example")) {
      return socket.end(
        "HTTP/1.1 403 Forbidden\r\nX-Keyd-Reason: host-denied\r\nContent-Length: 0\r\n\r\n",
      );
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.pipe(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: (server.address() as AddressInfo).port, seen };
}

const closers: (() => void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function setup(token: string | null = TOKEN, gateUp = true) {
  const gate = await fakeGate();
  closers.push(() => gate.server.close());
  const forwarder = createForwarder({
    gate: gateUp ? { host: "127.0.0.1", port: gate.port } : undefined,
    readToken: () => token ?? undefined,
  });
  forwarder.listen(0, "127.0.0.1");
  await once(forwarder, "listening");
  closers.push(() => forwarder.close());
  return { gate, port: (forwarder.address() as AddressInfo).port };
}

function viaProxy(port: number, url: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; text: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: body ? "POST" : "GET",
          path: url,
          // A proxy client names the origin in Host, as curl does.
          headers: {
            host: url.startsWith("http://") ? new URL(url).host : "127.0.0.1",
            ...headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => {
            text += c;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
        },
      );
      req.on("error", reject);
      if (body) req.write(body.slice(0, 2));
      req.end(body?.slice(2));
    },
  );
}

function tunnel(port: number, authority: string) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; socket: Socket }>(
    (resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "CONNECT", path: authority });
      req.on("connect", (res, socket: Socket) =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, socket }),
      );
      req.on("error", reject);
      req.end();
    },
  );
}

describe("the cell's proxy forwarder", () => {
  it("adds the cell's token to a plain request and replaces the client's own", async () => {
    const { gate, port } = await setup();
    const res = await viaProxy(
      port,
      "http://example.test/a?b=1",
      { "proxy-authorization": "Basic evil", cookie: "k=v" },
      "hello",
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({
      url: "http://example.test/a?b=1",
      body: "hello",
      cookie: "k=v",
    });
    expect(res.headers["x-upstream"]).toBe("yes");
    expect(gate.seen).toEqual([
      { method: "POST", url: "http://example.test/a?b=1", auth: BASIC, host: "example.test" },
    ]);
  });

  it("opens tunnels with the token and carries bytes both ways", async () => {
    const { gate, port } = await setup();
    const t = await tunnel(port, "example.test:443");
    expect(t.status).toBe(200);
    t.socket.write("ping");
    const [echo] = (await once(t.socket, "data")) as [Buffer];
    expect(echo.toString()).toBe("ping");
    t.socket.destroy();
    expect(gate.seen[0]).toMatchObject({ method: "CONNECT", url: "example.test:443", auth: BASIC });
  });

  it("relays keyd's refusals with their reason", async () => {
    const { port } = await setup();
    const plain = await viaProxy(port, "http://refused.example/");
    expect(plain.status).toBe(403);
    expect(plain.headers["x-keyd-reason"]).toBe("host-denied");
    const t = await tunnel(port, "refused.example:443");
    expect(t.status).toBe(403);
    expect(t.headers["x-keyd-reason"]).toBe("host-denied");
    t.socket.destroy();
  });

  it("never lets a client see a 407, which would make browsers prompt for the token", async () => {
    const { port } = await setup("s".repeat(43));
    const plain = await viaProxy(port, "http://example.test/");
    expect(plain.status).toBe(502);
    expect(plain.headers["x-localdot-reason"]).toBe("proxy-token-refused");
    expect(plain.headers["proxy-authenticate"]).toBeUndefined();
    const t = await tunnel(port, "example.test:443");
    expect(t.status).toBe(502);
    t.socket.destroy();
  });

  it("fails closed without a token or a gate, and never contacts the gate then", async () => {
    for (const [token, gateUp, reason] of [
      [null, true, "no-proxy-token"],
      [TOKEN, false, "no-gate"],
    ] as const) {
      const { gate, port } = await setup(token, gateUp);
      const plain = await viaProxy(port, "http://example.test/");
      expect(plain.status).toBe(503);
      expect(plain.headers["x-localdot-reason"]).toBe(reason);
      const t = await tunnel(port, "example.test:443");
      expect(t.status).toBe(503);
      t.socket.destroy();
      expect(gate.seen).toEqual([]);
    }
  });

  it("refuses origin-form requests and upgrades", async () => {
    const { gate, port } = await setup();
    expect((await viaProxy(port, "/local", { host: "127.0.0.1" })).status).toBe(400);
    const upgraded = await viaProxy(port, "http://example.test/ws", {
      connection: "upgrade",
      upgrade: "websocket",
    });
    expect(upgraded.status).toBe(501);
    expect(gate.seen).toEqual([]);
  });

  it("reads only a well-formed token from its file", () => {
    const dir = mkdtempSync(join(tmpdir(), "local dot's token-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "good"), `${TOKEN}\n`);
    writeFileSync(join(dir, "bad"), "short");
    expect(readTokenFile(join(dir, "good"))).toBe(TOKEN);
    expect(readTokenFile(join(dir, "bad"))).toBeUndefined();
    expect(readTokenFile(join(dir, "missing"))).toBeUndefined();
    for (const value of ["x".repeat(42), "x".repeat(44), "x".repeat(100_000), `a\nb${TOKEN}`]) {
      writeFileSync(join(dir, "bad"), value);
      expect(readTokenFile(join(dir, "bad"))).toBeUndefined();
    }
  });
});

describe("the forwarder process", () => {
  let child: ChildProcess | undefined;
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "close");
      child.kill("SIGKILL");
      await stopped;
    }
    child = undefined;
  });

  it("ignores the proxy variables of its environment, so it never loops or leaks", async () => {
    const gate = await fakeGate();
    closers.push(() => gate.server.close());
    const trap = await fakeGate();
    closers.push(() => trap.server.close());
    const dir = mkdtempSync(join(tmpdir(), "local dot's fwd-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "proxy-token"), TOKEN);
    const main = fileURLToPath(new URL("./forwarder-main.ts", import.meta.url));
    const trapUrl = `http://127.0.0.1:${trap.port}`;
    child = spawn(process.execPath, ["--import", "tsx", main], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        LOCALDOT_GATE_ADDR: "127.0.0.1",
        LOCALDOT_GATE_PORT: String(gate.port),
        LOCALDOT_FORWARDER_PORT: "0",
        LOCALDOT_PROXY_TOKEN_FILE: join(dir, "proxy-token"),
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: trapUrl,
        HTTPS_PROXY: trapUrl,
        http_proxy: trapUrl,
        https_proxy: trapUrl,
        NO_PROXY: "",
        no_proxy: "",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = once(child, "exit").then(() => {
      throw new Error("the forwarder exited");
    });
    const [line] = (await Promise.race([
      once(child.stdout as NodeJS.ReadableStream, "data"),
      exited,
    ])) as [Buffer];
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(line.toString())?.[1]);
    const res = await viaProxy(port, "http://example.test/");
    expect(res.status).toBe(200);
    expect(gate.seen).toHaveLength(1);
    expect(trap.seen).toEqual([]);
  }, 20_000);
});
