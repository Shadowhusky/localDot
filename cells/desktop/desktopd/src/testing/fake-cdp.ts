import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";

export type CdpHandler = (method: string, params: Record<string, unknown>) => unknown;

// A stand-in for the `ws` socket CdpSession opens: answers each command with the handler's
// result (or an error when the handler throws), and records what was sent.
export function fakeCdp(handler: CdpHandler): { WebSocketImpl: typeof WebSocket; sent: string[] } {
  const sent: string[] = [];
  class FakeSocket extends EventEmitter {
    readyState = 0;
    constructor(readonly url: string) {
      super();
      setImmediate(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }
    send(data: string, callback?: (error?: Error) => void) {
      callback?.();
      const msg = JSON.parse(data) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      sent.push(msg.method);
      setImmediate(() => {
        try {
          this.emit(
            "message",
            JSON.stringify({ id: msg.id, result: handler(msg.method, msg.params) }),
          );
        } catch (err) {
          this.emit(
            "message",
            JSON.stringify({ id: msg.id, error: { message: (err as Error).message } }),
          );
        }
      });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setImmediate(() => this.emit("close"));
    }
    terminate() {
      this.close();
    }
  }
  return { WebSocketImpl: FakeSocket as unknown as typeof WebSocket, sent };
}

export function fakeTargets(
  targets: { type: string; url: string; title?: string }[],
): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify(
        targets.map((t, i) => ({
          id: `t${i}`,
          title: t.title ?? "",
          webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/t${i}`,
          ...t,
        })),
      ),
    )) as unknown as typeof fetch;
}
