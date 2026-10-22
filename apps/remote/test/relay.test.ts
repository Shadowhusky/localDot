import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { WebSocketServer } from "ws";
import { connectRemote } from "../../daemon/src/remote/connector.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await sleep(50);
  }
  assert.ok(check(), "condition was not reached");
}

test("real Worker relay: pairing, HTTP streaming, WebSockets, isolation and revocation", {
  timeout: 30000,
}, async (t) => {
  const cleanup: (() => unknown)[] = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "relay",
          modules: true,
          scriptPath: "dist/worker.js",
          compatibilityDate: "2026-10-10",
          bindings: { REMOTE_DOMAIN: "example.com" },
          durableObjects: { DEVICES: { className: "DeviceRelay", useSQLite: true } },
        },
      ],
      port: 0,
    }),
  );
  cleanup.push(() => mf.dispose());
  await mf.ready;
  const owner = randomBytes(32).toString("hex"),
    access = randomBytes(32).toString("hex");
  const origin = `https://${hash(owner).slice(0, 32)}--dot.example.com`;
  const payload = randomBytes(4 * 1024 * 1024 + 7);
  let mutations = 0;
  const daemon = createServer(async (req, res) => {
    assert.equal(req.headers.host, new URL(origin).host);
    assert.equal(req.headers["x-forwarded-for"], "remote");
    assert.equal(req.headers.cookie, undefined);
    if (req.headers.authorization !== "Bearer test-token") {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    if (req.url === "/slow-response") {
      res.setHeader("content-type", "text/plain");
      res.flushHeaders();
      await sleep(50);
      res.write("first");
      await sleep(50);
      res.end("second");
      return;
    }
    if (req.url === "/download") {
      res.setHeader("content-type", "application/octet-stream");
      res.end(payload);
      return;
    }
    if (req.url === "/upload") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      res.end(hash(Buffer.concat(chunks).toString("hex")));
      return;
    }
    if (req.url === "/mutation") {
      mutations++;
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ path: req.url }));
  });
  daemon.listen(0, "127.0.0.1");
  await once(daemon, "listening");
  const address = daemon.address();
  assert.ok(address && typeof address !== "string");
  cleanup.push(() => {
    daemon.closeAllConnections();
    daemon.close();
  });
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("localdot.v1") ? "localdot.v1" : false),
  });
  daemon.on("upgrade", (req, socket, head) => {
    if (req.url === "/refused") {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws) => {
    ws.send("initial snapshot");
    ws.on("message", (data, binary) => ws.send(data, { binary }));
  });
  cleanup.push(() => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });
  // Miniflare's dispatch API preserves the public URL; this local HTTP facade lets the real
  // Node connector speak WebSocket to that Worker without needing public DNS or an account.
  const facade = createServer(async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const response = await mf.dispatchFetch(`${origin}${req.url}`, { method: req.method, headers });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.arrayBuffer());
  });
  const bridge = new WebSocketServer({ noServer: true });
  facade.on("upgrade", async (req, socket, head) => {
    const hostname = req.headers.host ?? new URL(origin).host;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const result = await mf.dispatchFetch(`https://${hostname}${req.url}`, { headers });
    if (!result.webSocket) {
      socket.end(`HTTP/1.1 ${result.status} Rejected\r\nConnection: close\r\n\r\n`);
      return;
    }
    const remote = result.webSocket;
    remote.accept();
    bridge.handleUpgrade(req, socket, head, (local) => {
      local.on("message", (data, binary) => remote.send(binary ? data : data.toString()));
      remote.addEventListener("message", (e) => local.send(e.data));
      local.on("close", () => {
        try {
          remote.close();
        } catch {}
      });
      remote.addEventListener("close", () => local.close());
      local.on("error", () => {
        try {
          remote.close();
        } catch {}
      });
    });
  });
  facade.listen(0, "127.0.0.1");
  await once(facade, "listening");
  const facadeAddress = facade.address();
  assert.ok(facadeAddress && typeof facadeAddress !== "string");
  cleanup.push(() => {
    for (const ws of bridge.clients) ws.terminate();
    bridge.close();
    facade.closeAllConnections();
    facade.close();
  });
  let state = "";
  const stop = connectRemote({
    origin,
    owner,
    accessHash: hash(access),
    port: address.port,
    dialOrigin: `http://127.0.0.1:${facadeAddress.port}`,
    status: (s) => {
      state = s;
    },
  });
  cleanup.push(stop);
  await eventually(() => state === "online");
  const call = (path: string, init: Parameters<typeof mf.dispatchFetch>[1] = {}) =>
    mf.dispatchFetch(`${origin}${path}`, init);
  assert.equal((await call("/api/private")).status, 401);
  assert.match(await (await call("/")).text(), /Connect to localDot/);
  assert.equal(
    (
      await call("/_remote/unlock", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ key: "0".repeat(64) }),
      })
    ).status,
    401,
  );
  const paired = await call("/_remote/unlock", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ key: access }),
  });
  assert.equal(paired.status, 204);
  const cookie = paired.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  assert.match(paired.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
  // The localDot menu on localhost or a tailnet address opens this origin from another site, where
  // the Strict cookie stays behind; the same address requested again by this origin carries it.
  // Miniflare's dispatch sets its own Sec-Fetch-Mode and restores the one given in MF-Sec-Fetch-Mode.
  const navigate = (path: string, more: Record<string, string> = {}) =>
    call(path, {
      headers: {
        "sec-fetch-site": "cross-site",
        "mf-sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        ...more,
      },
    });
  const bounced = await navigate("/?x=1&y=<2>");
  assert.equal(bounced.status, 200);
  assert.equal(bounced.headers.get("referrer-policy"), "same-origin");
  assert.equal(
    bounced.headers.get("content-security-policy"),
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  assert.ok(
    (await bounced.text()).includes(
      `<meta http-equiv="refresh" content="0;url=${origin}/?x=1&#38;y=%3C2%3E">`,
    ),
  );
  assert.ok(
    (await (await navigate("//attacker.example/x")).text()).includes(
      `content="0;url=${origin}//attacker.example/x"`,
    ),
    "the bounce never leaves this origin",
  );
  assert.match(
    await (await navigate("/", { referer: `${origin}/` })).text(),
    /isn't connected to this localDot yet/,
    "a visit bounces once: what this origin's page asked for gets the pair page",
  );
  assert.match(await (await navigate("/_remote/pair")).text(), /Connect to localDot/);
  assert.equal(
    await (await navigate("/", { cookie })).text(),
    "unauthorized",
    "a paired request reaches the computer",
  );
  assert.match(
    await (
      await call("/replay/1", {
        headers: { "sec-fetch-site": "same-origin", "mf-sec-fetch-mode": "navigate" },
      })
    ).text(),
    /Connect to localDot/,
  );
  const headers = { cookie, authorization: "Bearer test-token", origin };
  assert.equal(await (await call("/slow-response", { headers })).text(), "firstsecond");
  assert.match(
    await (await call("/_remote/pair", { headers })).text(),
    /Connect to localDot/,
    "fresh links must work in already-paired browsers",
  );
  assert.equal((await mf.dispatchFetch(`${origin.replace("https:", "http:")}/`)).status, 400);

  assert.equal(
    (await call("/api/private", { headers: { cookie } })).status,
    401,
    "pairing does not bypass daemon authentication",
  );
  assert.equal(
    (await call("/api/private", { headers: { ...headers, origin: "https://attacker.example" } }))
      .status,
    403,
  );
  assert.deepEqual(await (await call("/api/private?x=1", { headers })).json(), {
    path: "/api/private?x=1",
  });
  assert.deepEqual(
    Buffer.from(await (await call("/download", { headers })).arrayBuffer()),
    payload,
  );
  assert.equal(
    await (await call("/upload", { method: "POST", headers, body: payload })).text(),
    hash(payload.toString("hex")),
  );
  const refusedAt = Date.now();
  assert.equal(
    (await call("/refused", { headers: { ...headers, upgrade: "websocket" } })).status,
    503,
  );
  assert.ok(
    Date.now() - refusedAt < 5000,
    "a rejected local connection must not wait for the relay timeout",
  );
  const wsResponse = await call("/stream", {
    headers: { ...headers, upgrade: "websocket", "sec-websocket-protocol": "localdot.v1" },
  });
  assert.equal(wsResponse.status, 101);
  assert.equal(wsResponse.headers.get("sec-websocket-protocol"), "localdot.v1");
  const viewer = wsResponse.webSocket;
  assert.ok(viewer);
  const messages: (string | ArrayBuffer)[] = [];
  viewer.addEventListener("message", (e) => messages.push(e.data));
  viewer.accept();
  await eventually(() => messages.length > 0);
  assert.equal(messages.shift(), "initial snapshot");
  viewer.send("ping");
  await eventually(() => messages.length > 0);
  assert.equal(messages.shift(), "ping", "app messages must not be consumed as relay heartbeats");
  viewer.send("hello");
  await eventually(() => messages.length > 0);
  assert.equal(messages.shift(), "hello");
  viewer.send(new Uint8Array([0, 1, 2, 255]));
  await eventually(() => messages.length > 0);
  assert.deepEqual(new Uint8Array(messages.shift() as ArrayBuffer), new Uint8Array([0, 1, 2, 255]));
  await mf.unsafeEvictDurableObject("relay", "DeviceRelay", {
    name: hash(owner).slice(0, 32),
    webSockets: "hibernate",
  });
  viewer.send("after hibernation");
  await eventually(() => messages.length > 0);
  assert.equal(messages.shift(), "after hibernation");
  const other = `https://${"b".repeat(32)}--dot.example.com`;
  assert.equal((await mf.dispatchFetch(`${other}/api/private`, { headers })).status, 403);
  const mutation = call("/mutation", { method: "POST", headers });
  await eventually(() => mutations === 1);
  stop();
  assert.equal((await mutation).status, 503);
  await sleep(150);
  assert.equal(mutations, 1);
  assert.equal((await call("/api/private", { headers })).status, 503);
  const nextAccess = randomBytes(32).toString("hex");
  state = "";
  const stopNext = connectRemote({
    origin,
    owner,
    accessHash: hash(nextAccess),
    port: address.port,
    dialOrigin: `http://127.0.0.1:${facadeAddress.port}`,
    status: (s) => {
      state = s;
    },
  });
  cleanup.push(stopNext);
  await eventually(() => state === "online");
  assert.equal(
    (await call("/api/private", { headers })).status,
    401,
    "old pairing cookies are revoked",
  );
  assert.equal(
    (
      await call("/_remote/unlock", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ key: access }),
      })
    ).status,
    401,
    "old links are revoked",
  );
});
