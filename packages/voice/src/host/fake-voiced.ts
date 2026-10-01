import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import { encodeAudioFrame } from "../wire.ts";
import type { ChildLike } from "./supervisor.ts";

export type FakeTtsMode = "speak" | "stall" | "unavailable" | "hang-up";

// voiced's /tts as far as the host can tell: a greeting, two audio frames, the end, the track.
export async function startFakeVoiced(token: string, mode: () => FakeTtsMode = () => "speak") {
  const received: unknown[] = [];
  const server: Server = createServer();
  const wss = new WebSocketServer({
    server,
    handleProtocols: () => "localdot.v1",
    // Real voiced turns a wrong token away at the handshake (HTTP 403), never with a close code.
    verifyClient: ({ req }, done) => done(req.headers.authorization === `Bearer ${token}`, 403),
  });
  wss.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: "ready", voice: "stock" }));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type: string; id: number };
      received.push(message);
      if (message.type !== "say") return;
      const behaviour = mode();
      if (behaviour === "hang-up") return socket.terminate();
      if (behaviour === "stall") {
        socket.send(encodeAudioFrame(message.id, 0, new Int16Array([1, 2, 3])));
        return;
      }
      if (behaviour === "unavailable") {
        socket.send(
          JSON.stringify({
            type: "error",
            id: message.id,
            code: "unavailable",
            message: "model refused",
          }),
        );
        return;
      }
      socket.send(encodeAudioFrame(message.id, 0, new Int16Array([1, 2, 3])));
      socket.send(encodeAudioFrame(message.id, 1, new Int16Array([4, 5])));
      socket.send(JSON.stringify({ type: "end", id: message.id, samples: 5 }));
      socket.send(
        JSON.stringify({
          type: "track",
          id: message.id,
          lang: "en",
          visemes: [{ t: 0, shape: "A" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    host: `127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

// voiced's process as the supervisor sees it: it dies on SIGTERM unless told not to.
export class FakeChild extends EventEmitter implements ChildLike {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  readonly signals: string[] = [];
  diesOnTerm = true;
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL" || this.diesOnTerm) this.exit(signal === "SIGKILL" ? 137 : 0);
    return true;
  }
  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code);
  }
  // Like Node when the command cannot run (uv not installed): an error, and never an exit.
  fail(error: Error): void {
    this.pid = undefined;
    this.exitCode = -2;
    this.emit("error", error);
  }
}
