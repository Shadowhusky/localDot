import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, "client");
const UPSTREAM = { host: "127.0.0.1", port: 4791 };
const AUTH = `Basic ${Buffer.from("localdot:s8password").toString("base64")}`;
const PREFIX = "/d/t1";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendFile(res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:4792");
  if (url.pathname === "/") return sendFile(res, join(here, "page.html"));
  if (url.pathname === "/worker.js") return sendFile(res, join(here, "worker.js"));
  if (!url.pathname.startsWith(`${PREFIX}/`)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const rel = url.pathname.slice(PREFIX.length);
  if (rel.startsWith("/api/")) {
    const up = httpRequest(
      { ...UPSTREAM, method: req.method, path: `${rel}${url.search}`, headers: { authorization: AUTH } },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, { "content-type": upRes.headers["content-type"] ?? "application/octet-stream" });
        upRes.pipe(res);
      },
    );
    up.on("error", (err) => {
      res.writeHead(502);
      res.end(err.message);
    });
    up.end();
    return;
  }
  sendFile(res, join(CLIENT, normalize(rel === "/" ? "/index.html" : rel)));
});

const wss = new WebSocketServer({ noServer: true });
const stats = { up: 0, upBytes: 0, down: 0, pings: 0, pongs: 0, lastUpstreamAt: 0, longestSilenceMs: 0 };
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:4792");
  if (url.pathname !== `${PREFIX}/api/websockets`) {
    socket.destroy();
    return;
  }
  // Dial the desktop first and finish the viewer's upgrade from its open: the client sends its
  // settings the moment its socket opens, and Selkies streams nothing until it has them.
  const upstream = new WebSocket(`ws://${UPSTREAM.host}:${UPSTREAM.port}/api/websockets${url.search}`, {
    headers: { authorization: AUTH },
    perMessageDeflate: false,
  });
  let client = null;
  let viewerGone = false;
  const abandon = () => {
    viewerGone = true;
    upstream.terminate();
  };
  socket.on("error", () => socket.destroy());
  socket.once("close", abandon);
  const touch = () => {
    const now = Date.now();
    if (stats.lastUpstreamAt) stats.longestSilenceMs = Math.max(stats.longestSilenceMs, now - stats.lastUpstreamAt);
    stats.lastUpstreamAt = now;
  };
  const ping = setInterval(() => {
    if (upstream.readyState === WebSocket.OPEN) upstream.ping();
  }, 500);
  upstream.on("open", () => {
    console.log("upstream open");
    wss.handleUpgrade(req, socket, head, (ws) => {
      socket.off("close", abandon);
      client = ws;
      client.on("message", (data, isBinary) => {
        stats.down += 1;
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });
      client.on("error", () => {});
      client.on("close", () => upstream.close());
    });
  });
  upstream.on("message", (data, isBinary) => {
    stats.up += 1;
    stats.upBytes += data.length ?? 0;
    touch();
    if (client?.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("ping", () => { stats.pings += 1; touch(); });
  upstream.on("pong", () => { stats.pongs += 1; touch(); });
  upstream.on("error", (err) => console.log("upstream error", err.message));
  upstream.on("close", (code, reason) => {
    console.log("upstream close", code, String(reason));
    clearInterval(ping);
    if (client?.readyState === WebSocket.OPEN) client.close(1012, "upstream closed");
    else if (!client && !viewerGone) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
});

let last = { ...stats, at: Date.now() };
setInterval(() => {
  const now = Date.now();
  const dt = (now - last.at) / 1000;
  const rate = (key) => ((stats[key] - last[key]) / dt).toFixed(1);
  console.log(
    `upstream msgs/s ${rate("up")} kB/s ${((stats.upBytes - last.upBytes) / dt / 1024).toFixed(0)} ` +
      `pings/s ${rate("pings")} pongs/s ${rate("pongs")} client msgs/s ${rate("down")} ` +
      `silence now ${stats.lastUpstreamAt ? now - stats.lastUpstreamAt : "-"} ms, longest ${stats.longestSilenceMs} ms`,
  );
  last = { ...stats, at: now };
}, 5000);

server.listen(4792, "127.0.0.1", () => console.log("host on http://127.0.0.1:4792"));
