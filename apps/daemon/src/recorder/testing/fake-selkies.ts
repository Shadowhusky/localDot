import { createServer, type IncomingHttpHeaders } from "node:http";
import { synthFrame } from "@localdot/stage/testing";
import WebSocket, { WebSocketServer } from "ws";

export interface FakeSelkies {
  baseUrl: string;
  requests: { url: string; headers: IncomingHttpHeaders }[];
  texts: string[];
  textTimes: number[];
  waitForText(text: string): Promise<void>;
  closeAll(): void;
  silence(): void;
  still(on: boolean): void;
  resetPipeline(): void;
  sendRaw(bytes: Uint8Array): void;
  close(): Promise<void>;
}
export async function startFakeSelkies(opts: {
  authorization: string;
  keyEvery?: number;
  fps?: number;
}): Promise<FakeSelkies> {
  const keyEvery = opts.keyEvery ?? 12;
  const fps = opts.fps ?? 60;
  if (
    !Number.isSafeInteger(keyEvery) ||
    keyEvery < 2 ||
    keyEvery > 16 ||
    !Number.isFinite(fps) ||
    fps <= 0
  )
    throw new RangeError("invalid fake stream parameters");
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, autoPong: false });
  const clients = new Map<WebSocket, { running: boolean; index: number; forceKey: boolean }>();
  const requests: FakeSelkies["requests"] = [];
  const texts: string[] = [];
  const textTimes: number[] = [];
  const waiters = new Set<{
    text: string;
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let silent = false;
  let still = false;
  let closed: Promise<void> | undefined;
  server.on("upgrade", (req, socket, head) => {
    requests.push({ url: req.url ?? "", headers: { ...req.headers } });
    if (
      req.headers.authorization !== opts.authorization ||
      req.url !== "/api/websockets?role=viewer"
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const state = { running: false, index: 0, forceKey: true };
      clients.set(ws, state);
      ws.on("error", () => {});
      ws.on("close", () => clients.delete(ws));
      ws.on("ping", (data) => {
        if (!silent && ws.readyState === WebSocket.OPEN) ws.pong(data);
      });
      ws.on("message", (data, binary) => {
        if (binary) return;
        const text = data.toString();
        texts.push(text);
        textTimes.push(performance.now());
        for (const waiter of [...waiters]) {
          if (waiter.text !== text) continue;
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          waiter.resolve();
        }
        if (text === "STOP_VIDEO") state.running = false;
        else if (text === "START_VIDEO") {
          state.running = true;
          state.forceKey = true;
        } else if (text === "REQUEST_KEYFRAME") state.forceKey = true;
      });
      ws.send("MODE websockets");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake server has no TCP address");
  const timer = setInterval(
    () => {
      if (silent || still) return;
      for (const [ws, state] of clients) {
        if (!state.running || ws.readyState !== WebSocket.OPEN) continue;
        if (state.forceKey) {
          state.index = Math.ceil(state.index / keyEvery) * keyEvery;
          state.forceKey = false;
        }
        const frame = synthFrame({ widthMbs: 4, heightMbs: 4, keyEvery }, state.index++);
        const bytes = Buffer.alloc(12 + frame.data.length);
        bytes[0] = 4;
        bytes[1] = frame.key ? 0x11 : 0x10;
        bytes.writeUInt16BE(state.index % 65536, 2);
        bytes.writeUInt16BE(64, 6);
        bytes.writeUInt16BE(64, 8);
        bytes.set(frame.data, 12);
        ws.send(bytes);
      }
    },
    Math.max(1, Math.floor(1000 / fps)),
  );
  const closeAll = () => {
    for (const ws of clients.keys()) ws.terminate();
  };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    texts,
    textTimes,
    waitForText(text) {
      if (texts.includes(text)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = {
          text,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`fake stream never received ${text}`));
          }, 5000),
        };
        waiters.add(waiter);
      });
    },
    closeAll,
    silence() {
      silent = true;
    },
    still(on) {
      still = on;
    },
    resetPipeline() {
      for (const [ws, state] of clients) {
        state.running = false;
        if (ws.readyState === WebSocket.OPEN) ws.send("PIPELINE_RESETTING primary");
      }
    },
    sendRaw(bytes) {
      for (const ws of clients.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
    },
    close() {
      if (closed) return closed;
      clearInterval(timer);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("fake stream closed"));
      }
      waiters.clear();
      closeAll();
      closed = Promise.all([
        new Promise<void>((resolve, reject) =>
          wss.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
      ]).then(() => {});
      return closed;
    },
  };
}
