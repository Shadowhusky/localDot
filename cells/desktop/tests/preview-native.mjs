// Runs only in a disposable desktop-image fixture. No user accounts or external network.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { setTimeout as delay } from "node:timers/promises";

const token = "p".repeat(43);
async function api(path, body) {
  const res = await fetch(`http://127.0.0.1:7700${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`${path}: ${res.status}: ${text}`);
  }
  return { status: res.status, body: result };
}
async function until(fn) {
  const deadline = Date.now() + 15000;
  let error;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      error = e;
    }
    await delay(100);
  }
  throw new Error(`preview did not settle: ${error}`);
}
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
    "/CN=preview.localhost",
    "-addext",
    "subjectAltName=DNS:preview.localhost,DNS:branch.preview.localhost,DNS:preview-public.test,DNS:localhost.attacker.test,DNS:localhost,IP:127.0.0.1",
    "-keyout",
    "/tmp/preview-key.pem",
    "-out",
    "/tmp/preview-cert.pem",
  ],
  { stdio: "ignore" },
);
const server = createServer(
  { key: readFileSync("/tmp/preview-key.pem"), cert: readFileSync("/tmp/preview-cert.pem") },
  (req, res) => {
    if (req.url === "/redirect-public") {
      res.writeHead(302, { location: "https://preview-public.test:1355/" });
      return res.end();
    }
    if (req.url === "/api") {
      res.setHeader("content-type", "application/json");
      return res.end('{"ready":true}');
    }
    res.setHeader("content-type", "text/html");
    res.end(
      `<!doctype html><title>Local HTTPS preview</title><style>body{font:24px sans-serif;background:#eff5fb;padding:60px}button{font:inherit;padding:20px}</style><h1>Local HTTPS preview</h1><p id=status>Connecting</p><button onclick="this.textContent='Clicked successfully'">Test interaction</button><script>fetch('/api').then(r=>r.json()).then(()=>{const ws=new WebSocket('wss://'+location.host+'/live');ws.onmessage=e=>document.querySelector('#status').textContent='API and live updates ready';});</script>`,
    );
  },
);
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.write(Buffer.from([0x81, 4, 108, 105, 118, 101]));
  socket.on("error", () => {});
});
await new Promise((resolve) => server.listen(1355, "127.0.0.1", resolve));
await until(
  async () => (await api("/browser/task", { taskId: `01J${"0".repeat(22)}1` })).status === 200,
);
const browser = spawn("/usr/local/bin/localdot-chromium", ["about:blank"], { stdio: "ignore" });
let ws;
try {
  await until(async () =>
    (await (await fetch("http://127.0.0.1:9222/json/list")).json()).some((t) => t.type === "page"),
  );
  for (const host of ["preview.localhost", "branch.preview.localhost", "localhost", "127.0.0.1"]) {
    const result = await api("/browser/navigate", { url: `https://${host}:1355/` });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.loaded, true);
    await until(async () =>
      (await api("/browser/read", { maxChars: 2000 })).body.text?.includes(
        "API and live updates ready",
      ),
    );
    console.log(`PASS visible HTTPS, fetch, and WSS: ${host}:1355`);
  }
  const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  async function cdp(method, params = {}) {
    const id = ++seq;
    const reply = new Promise((resolve) => pending.set(id, resolve));
    ws.send(JSON.stringify({ id, method, params }));
    const timer = AbortSignal.timeout(5000);
    const msg = await Promise.race([
      reply,
      new Promise((_, reject) =>
        timer.addEventListener("abort", () => reject(new Error("CDP timeout")), { once: true }),
      ),
    ]);
    assert.equal(msg.error, undefined);
    return msg.result;
  }
  const point = await cdp("Runtime.evaluate", {
    expression:
      '(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
    returnByValue: true,
  });
  for (const type of ["mousePressed", "mouseReleased"])
    await cdp("Input.dispatchMouseEvent", {
      type,
      ...point.result.value,
      button: "left",
      clickCount: 1,
    });
  assert.match((await api("/browser/read", { maxChars: 2000 })).body.text, /Clicked successfully/);
  const png = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync("/tmp/local-preview-verified.png", Buffer.from(png.data, "base64"));
  console.log("PASS visible interaction and screenshot");
  ws.close();
  ws = undefined;
  for (const host of ["preview-public.test", "localhost.attacker.test"]) {
    const result = await api("/browser/navigate", { url: `https://${host}:1355/` });
    assert.equal(result.status, 502, JSON.stringify(result));
    assert.deepEqual(result.body, { error: "browser", code: "certificate" });
    await until(
      async () => (await api("/browser/read", { maxChars: 2000 })).body.title === "Privacy error",
    );
    console.log(`PASS strict certificate validation: ${host}`);
  }
  console.log("Checking redirect");
  const redirect = await api("/browser/navigate", {
    url: "https://preview.localhost:1355/redirect-public",
  });
  assert.equal(redirect.status, 502);
  assert.equal(redirect.body.code, "certificate");
  console.log("Checking stopped server");
  const refused = await api("/browser/navigate", { url: "https://preview.localhost:1356/" });
  assert.equal(refused.status, 502);
  assert.equal(refused.body.code, "connection");
  console.log("Checking unsafe port");
  const unsafe = await api("/browser/navigate", { url: "https://preview.localhost:6667/" });
  assert.equal(unsafe.status, 502);
  assert.equal(unsafe.body.code, "unsafe_port");
  console.log("PASS public redirect, stopped server, and genuine unsafe-port diagnostics");
} finally {
  ws?.close();
  browser.kill("SIGTERM");
  server.closeAllConnections();
  server.close();
}
process.exit(0);
