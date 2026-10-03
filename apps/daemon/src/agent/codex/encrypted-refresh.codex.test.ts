import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { AccountRead, AppServerRpc, type CodexProcess } from "@localdot/codex-harness";
import { afterEach, expect, it } from "vitest";
import {
  type NativeFixture,
  prepareNativeFixture,
} from "../../../../../harness/codex/src/testing/native-fixture.ts";
import { fakeAuthJson, fakeTokens } from "./testing/openai-mock.ts";

if (process.env.LOCALDOT_CODEX_TESTS !== "1")
  throw new Error("Native encrypted refresh requires explicit offline opt-in.");
const archive = process.env.LOCALDOT_CODEX_ARCHIVE;
assert.ok(archive);
let fixture: NativeFixture | undefined;
let rpc: AppServerRpc | undefined;
let owner: CodexProcess | undefined;
let retiring = false;
const servers: Server[] = [];
const sockets = new Set<Socket>();
const faults: string[] = [];
function ownSocket(socket: Socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {
    if (!retiring) faults.push("owned transport error");
  });
  socket.setTimeout(5_000, () => {
    if (!retiring) faults.push("owned transport deadline");
    socket.destroy();
  });
}
async function listen(server: Server) {
  servers.push(server);
  server.on("connection", ownSocket);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
afterEach(async () => {
  retiring = true;
  const errors: unknown[] = [];
  rpc?.close();
  if (owner) {
    try {
      await owner.stop();
      await owner.closed;
    } catch (error) {
      errors.push(error);
    }
  }
  for (const socket of sockets) socket.destroy();
  for (const server of servers.splice(0).reverse()) {
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      expect(server.listening).toBe(false);
    } catch (error) {
      errors.push(error);
    }
  }
  if (fixture) {
    try {
      const retain = errors.length > 0 || faults.length > 0;
      await fixture.close({ retain });
      expect(existsSync(fixture.root)).toBe(retain);
    } catch (error) {
      errors.push(error);
    }
  }
  expect(faults).toEqual([]);
  if (errors.length)
    throw new AggregateError(errors, "Owned encrypted-refresh fixture cleanup failed.");
});

it("refreshes inert auth over verified TLS inside the strict native account profile", async () => {
  retiring = false;
  fixture = await prepareNativeFixture(archive);
  const f = fixture;
  const files = await f.authCertificate();
  const requests: {
    method: string;
    path: string;
    body: string;
    encrypted: boolean;
    protocol: string | null;
  }[] = [];
  const tls = createHttpsServer(
    {
      cert: readFileSync(files.certificate),
      key: readFileSync(files.privateKey),
      minVersion: "TLSv1.2",
    },
    (req, res) => {
      void (async () => {
        const parts: Buffer[] = [];
        let size = 0;
        for await (const part of req) {
          const buffer = Buffer.from(part);
          size += buffer.byteLength;
          assert.ok(size <= 8192);
          parts.push(buffer);
        }
        const socket = req.socket as TLSSocket;
        assert.ok(requests.length < 4);
        requests.push({
          method: req.method ?? "",
          path: req.url ?? "",
          body: Buffer.concat(parts).toString("utf8"),
          encrypted: socket.encrypted,
          protocol: socket.getProtocol(),
        });
        if (
          req.method === "GET" &&
          req.headers.host === "chatgpt.com" &&
          req.url?.startsWith("/backend-api/codex/models")
        ) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ models: [] }));
          return;
        }
        if (
          req.method !== "POST" ||
          req.url !== "/oauth/token" ||
          req.headers.host !== "auth.openai.com"
        ) {
          faults.push("unexpected owned TLS endpoint");
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(fakeTokens(2, 3600)));
      })().catch(() => {
        faults.push("owned TLS request failed");
        res.destroy();
      });
    },
  );
  tls.headersTimeout = 5_000;
  tls.requestTimeout = 5_000;
  tls.on("tlsClientError", (_error, socket) => {
    // The bare-TCP positive control sends no TLS bytes. Every actual handshake must succeed.
    if (!retiring && socket.bytesRead > 0) faults.push("owned TLS handshake failed");
  });
  const tlsPort = await listen(tls);
  const tunnels: string[] = [];
  const proxy = createHttpServer((_req, res) => {
    faults.push("unexpected plain proxy request");
    res.writeHead(403).end();
  });
  proxy.headersTimeout = 5_000;
  proxy.requestTimeout = 5_000;
  proxy.on("connect", (req, socket, head) => {
    assert.ok(tunnels.length < 4);
    const target = req.url ?? "";
    tunnels.push(target);
    // No DNS or external dial exists in this fixture. The sole target is wired to our TLS
    // listener; every other CONNECT is refused before creating an upstream connection.
    if (!["auth.openai.com:443", "chatgpt.com:443"].includes(target) || head.byteLength > 8192) {
      faults.push("unexpected owned CONNECT target");
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = createConnection({ host: "127.0.0.1", port: tlsPort });
    ownSocket(upstream);
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.byteLength) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
  });
  const httpPort = await listen(proxy);
  let socksConnections = 0;
  const socks = createServer((socket) => {
    socksConnections++;
    socket.end();
  });
  const socksPort = await listen(socks);
  const directArgs = ["connect", "127.0.0.1", String(tlsPort)];
  // A live unsandboxed control prevents connection-refused/absent fixture false positives.
  expect((await f.probe("account", directArgs, false)).ok).toBe(true);
  const denied = await f.probe("account", directArgs);
  expect(denied.ok).toBe(false);
  expect([1, 13]).toContain(denied.errno);
  writeFileSync(join(f.roots.home, "auth.json"), fakeAuthJson(1, 3600), { mode: 0o600 });
  owner = await f.account([httpPort, socksPort]);
  assert.ok(owner.stdin && owner.stdout);
  let stderr = "";
  owner.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    assert.ok(Buffer.byteLength(stderr) <= 65_536);
  });
  const failures: unknown[] = [];
  rpc = new AppServerRpc({
    input: owner.stdout,
    output: owner.stdin,
    signal: f.signal,
    onServerRequest: () => ({
      error: { code: -32001, message: "Owned account fixture refuses every tool." },
      current: () => false,
    }),
    onNotification: () => {},
    onFailure: (error) => {
      failures.push(error);
    },
  });
  await owner.started;
  await rpc.request(
    "initialize",
    {
      clientInfo: {
        name: "localdot-native-fixture",
        title: "Inert native fixture",
        version: "0.0.0",
      },
      capabilities: { experimentalApi: true },
    },
    {
      signal: f.signal,
      timeoutMs: 15_000,
      validateResult: (value) => {
        assert.ok(value && typeof value === "object" && !Array.isArray(value));
        return value;
      },
    },
  );
  rpc.notify("initialized", {});
  const account = await rpc.request(
    "account/read",
    { refreshToken: true },
    { signal: f.signal, timeoutMs: 20_000, validateResult: AccountRead.parse },
  );
  expect(account.account).toMatchObject({ type: "chatgpt", email: "user@example.invalid" });
  const refreshes = requests.filter((request) => request.path === "/oauth/token");
  expect(
    refreshes,
    JSON.stringify({ requests, tunnels, faults, socksConnections, stderr }),
  ).toHaveLength(1);
  expect(refreshes[0]).toMatchObject({ method: "POST", path: "/oauth/token", encrypted: true });
  expect(["TLSv1.2", "TLSv1.3"]).toContain(refreshes[0]?.protocol);
  expect(refreshes[0]?.body).toContain("rt-1");
  expect(tunnels.filter((target) => target === "auth.openai.com:443")).toHaveLength(1);
  expect(
    tunnels.every((target) => ["auth.openai.com:443", "chatgpt.com:443"].includes(target)),
  ).toBe(true);
  expect(socksConnections).toBe(0);
  const auth = JSON.parse(readFileSync(join(f.roots.home, "auth.json"), "utf8"));
  expect(auth.tokens.refresh_token).toBe("rt-2");
  expect(lstatSync(join(f.roots.home, "auth.json")).mode & 0o777).toBe(0o600);
  expect(failures).toEqual([]);
  expect(faults).toEqual([]);
  rpc.close();
  await owner.stop();
  await owner.closed;
  expect(owner.stdin.writableEnded).toBe(true);
  expect(failures).toEqual([]);
}, 65_000);
