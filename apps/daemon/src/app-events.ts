import {
  type AttentionChangeEvent,
  ClientMessage,
  type ConversationLiveEvent,
  type RoutineAppEvent,
} from "@localdot/protocol";
import type { PresenceBoard } from "./notify/presence.ts";
import { tokenSocketServer, type UpgradeRoute } from "./upgrade-router.ts";

// App-wide notices for every signed-in client, whatever task they are looking at.
export type AppEvent = AttentionChangeEvent | RoutineAppEvent | ConversationLiveEvent;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost):\d+$/;

export class AppEvents {
  readonly #listeners = new Set<(event: AppEvent) => void>();
  publish(event: AppEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        console.error("an app event listener failed");
      }
    }
  }
  subscribe(listener: (event: AppEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

// GET /api/events (WebSocket, install token). A client may send its presence and confirm a
// notification it showed.
export function appEventsRoute(events: AppEvents, presence?: PresenceBoard): UpgradeRoute {
  const wss = tokenSocketServer({ maxPayload: 1024 });
  return {
    pattern: /^\/api\/events$/,
    params: [],
    auth: "token",
    open({ req, socket, head }) {
      // Both names must be the loopback one: a front that rewrote Host would still send its
      // page's https Origin.
      const host = req.headers.host ?? "";
      const local = LOOPBACK_HOST.test(host) && req.headers.origin === `http://${host}`;
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => {});
        const seen = presence?.connect(local);
        const unsubscribe = events.subscribe((event) => {
          // A notification a tab shows itself stands in for this Mac's banner: other devices
          // have their own pushes.
          if (event.type === "attention.change" && event.page && !local) return;
          if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.terminate();
          else ws.send(JSON.stringify(event));
        });
        ws.on("message", (data) => {
          let value: unknown;
          try {
            value = JSON.parse(String(data));
          } catch {
            return;
          }
          const parsed = ClientMessage.safeParse(value);
          if (!parsed.success) return;
          if (parsed.data.type === "presence") seen?.update(parsed.data);
          else if (local) presence?.shown(parsed.data.key);
        });
        ws.on("close", () => {
          unsubscribe();
          seen?.close();
        });
      });
    },
  };
}
