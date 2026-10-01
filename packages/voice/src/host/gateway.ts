import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { PROTOCOL } from "../socket.ts";
import { MAX_SENTENCE_CHARS, type TtsClientMessage } from "../wire.ts";
import type { TtsOutput } from "./router.ts";

export const TTS_PATH = "/voice/tts";
export const STT_PATH = "/voice/stt";

export interface TtsSessionLike {
  handle(message: TtsClientMessage): void;
  close(): void;
}

export interface GatewayOptions {
  authorize(request: IncomingMessage): boolean;
  tts(out: TtsOutput): TtsSessionLike;
  stt?(browser: WebSocket): void;
}

// The page's two voice routes on an existing HTTP server; every other upgrade is left alone.
export function attachVoiceGateway(server: Server, options: GatewayOptions): () => void {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== TTS_PATH && path !== STT_PATH) return;
    if (!options.authorize(request) || (path === STT_PATH && !options.stt)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (browser) => {
      if (path === TTS_PATH) serveTts(browser, options);
      else options.stt?.(browser);
    });
  };
  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}

function serveTts(browser: WebSocket, options: GatewayOptions): void {
  const session = options.tts({
    frame: (bytes) => browser.send(bytes),
    message: (message) => browser.send(JSON.stringify(message)),
  });
  browser.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const message = parseTtsClientMessage(data.toString());
    if (message) session.handle(message);
  });
  browser.on("close", () => session.close());
  browser.on("error", () => browser.terminate());
}

export function parseTtsClientMessage(text: string): TtsClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  if (m.type === "cancel") return { type: "cancel" };
  if (
    m.type === "say" &&
    Number.isInteger(m.id) &&
    (m.id as number) >= 0 &&
    (m.id as number) <= 0xffff_ffff &&
    typeof m.text === "string" &&
    m.text.trim().length > 0 &&
    m.text.length <= MAX_SENTENCE_CHARS &&
    (m.lang === "zh" || m.lang === "en" || m.lang === "ja")
  ) {
    return { type: "say", id: m.id as number, text: m.text, lang: m.lang };
  }
  return null;
}

// For a dev server: only its own page on 127.0.0.1 or localhost may open the voice routes.
export function isLocalPage(request: IncomingMessage, port: number): boolean {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origin = request.headers.origin;
  return (
    hosts.includes(request.headers.host ?? "") &&
    origin !== undefined &&
    hosts.some((host) => origin === `http://${host}`)
  );
}
