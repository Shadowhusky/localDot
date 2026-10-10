import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import {
  CHUNK,
  cleanHeaders,
  HEARTBEAT,
  HEARTBEAT_ACK,
  MAX_CHANNELS,
  MAX_FRAME,
  type Open,
  validOpen,
} from "@localdot/protocol/remote";
import { WebSocket } from "ws";

export interface ConnectorOptions {
  origin: string;
  owner: string;
  accessHash: string;
  port: number;
  status(state: "connecting" | "online" | "offline"): void;
  // Local runtime tests use a loopback Worker while retaining the public Host header.
  dialOrigin?: string;
}
export function connectRemote(options: ConnectorOptions): () => void {
  let stopped = false;
  let host: WebSocket | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let backoff = 1000;
  const channels = new Map<string, () => void>();
  const socket = (path: string, extra: Record<string, string> = {}) =>
    new WebSocket(`${(options.dialOrigin ?? options.origin).replace(/^http/, "ws")}${path}`, {
      headers: {
        host: new URL(options.origin).host,
        authorization: `Bearer ${options.owner}`,
        ...extra,
      },
      maxPayload: MAX_FRAME,
      handshakeTimeout: 10_000,
      followRedirects: false,
      perMessageDeflate: false,
    });
  const closeChannels = () => {
    for (const close of channels.values()) close();
    channels.clear();
  };
  const openChannel = (open: Open) => {
    if (channels.size >= MAX_CHANNELS || channels.has(open.id)) return;
    const headers = Object.fromEntries(cleanHeaders(open.headers));
    // The relay can never choose a target: this connector reaches only its own daemon.
    headers.host = new URL(options.origin).host;
    headers["x-forwarded-for"] = "remote";
    headers["x-forwarded-proto"] = "https";
    headers["accept-encoding"] = "identity";
    let remote: WebSocket | undefined;
    let upstream: WebSocket | undefined;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let ended = false;
    let pulling = false;
    let iterator: AsyncIterator<Buffer> | undefined;
    let rest: Buffer | undefined;
    let timer = setTimeout(() => close(), 60_000);
    const close = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      channels.delete(open.id);
      if (host?.readyState === WebSocket.OPEN) host.send(JSON.stringify({ failed: open.id }));
      remote?.terminate();
      upstream?.terminate();
      request?.destroy();
      response?.destroy();
    };
    channels.set(open.id, close);
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(close, 60_000);
    };
    const wire = (s: WebSocket) => {
      remote = s;
      s.on("error", close);
      s.on("close", close);
    };
    if (open.kind === "ws") {
      const protocols = open.headers
        .find(([k]) => k.toLowerCase() === "sec-websocket-protocol")?.[1]
        .split(/\s*,\s*/);
      upstream = new WebSocket(`ws://127.0.0.1:${options.port}${open.path}`, protocols, {
        headers,
        maxPayload: MAX_FRAME,
        handshakeTimeout: 10_000,
        followRedirects: false,
        perMessageDeflate: false,
      });
      upstream.on("error", close);
      upstream.on("close", close);
      // Pause before opening the other leg so the first snapshot/frame cannot be lost.
      upstream.on("open", () => {
        upstream?.pause();
        if (ended) return;
        const peer = socket(
          `/_remote/channel/${open.id}`,
          upstream?.protocol ? { "x-localdot-protocol": upstream.protocol } : {},
        );
        wire(peer);
        peer.on("open", () => {
          clearTimeout(timer);
          upstream?.resume();
        });
        peer.on("message", (data, binary) => {
          if (upstream?.readyState !== WebSocket.OPEN || upstream.bufferedAmount > MAX_FRAME * 2)
            return close();
          upstream.send(data, { binary });
        });
      });
      upstream.on("message", (data, binary) => {
        if (remote?.readyState !== WebSocket.OPEN || remote.bufferedAmount > MAX_FRAME * 2)
          return close();
        remote.send(data, { binary });
      });
      return;
    }
    const peer = socket(`/_remote/channel/${open.id}`);
    wire(peer);
    peer.on("open", () => {
      if (ended) return;
      request = httpRequest(
        {
          hostname: "127.0.0.1",
          port: options.port,
          path: open.path,
          method: open.method,
          headers,
        },
        (res) => {
          response = res;
          iterator = res[Symbol.asyncIterator]();
          const responseHeaders: [string, string][] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            responseHeaders.push([res.rawHeaders[i] ?? "", res.rawHeaders[i + 1] ?? ""]);
          peer.send(
            JSON.stringify({
              status: res.statusCode ?? 502,
              headers: cleanHeaders(responseHeaders),
            }),
          );
        },
      );
      request.on("error", close);
      peer.send("pull-upload");
    });
    peer.on("message", async (data, binary) => {
      touch();
      try {
        if (binary) {
          const chunk = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          if (chunk.length > CHUNK || !request) return close();
          request.write(chunk, () => {
            if (!ended) peer.send("pull-upload");
          });
        } else if (data.toString() === "upload-end") request?.end();
        else if (data.toString() === "pull-response") {
          if (pulling || !iterator) return close();
          pulling = true;
          const part = rest?.length ? { value: rest, done: false } : await iterator.next();
          if (ended) return;
          if (part.done) {
            peer.send("response-end");
            pulling = false;
            return;
          }
          rest = part.value.subarray(CHUNK);
          peer.send(part.value.subarray(0, CHUNK));
          pulling = false;
        } else close();
      } catch {
        close();
      }
    });
  };
  const connect = () => {
    if (stopped) return;
    options.status("connecting");
    const connection = socket("/_remote/host", { "x-localdot-access-sha256": options.accessHash });
    host = connection;
    let alive = true;
    connection.on("open", () => {
      if (stopped || host !== connection) return connection.close();
      options.status("online");
      backoff = 1000;
      ping = setInterval(() => {
        if (!alive) {
          connection.terminate();
          return;
        }
        alive = false;
        connection.send(HEARTBEAT);
      }, 30_000);
      ping.unref();
    });
    connection.on("message", (data) => {
      if (stopped || host !== connection) return;
      if (data.toString() === HEARTBEAT_ACK) {
        alive = true;
        return;
      }
      try {
        const open: unknown = JSON.parse(data.toString());
        if (validOpen(open)) openChannel(open);
      } catch {
        connection.close(1008, "Invalid request");
      }
    });
    connection.on("error", () => {});
    connection.on("close", () => {
      if (host !== connection) return;
      clearInterval(ping);
      closeChannels();
      if (!stopped) options.status("offline");
      if (!stopped) {
        reconnect = setTimeout(connect, backoff + Math.random() * 500);
        reconnect.unref();
        backoff = Math.min(backoff * 2, 30_000);
      }
    });
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(reconnect);
    clearInterval(ping);
    closeChannels();
    host?.terminate();
  };
}
