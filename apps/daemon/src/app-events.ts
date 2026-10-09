import type { RoutineAppEvent } from "@localdot/protocol";
import { tokenSocketServer, type UpgradeRoute } from "./upgrade-router.ts";

// App-wide notices for every signed-in client, whatever task they are looking at.
export type AppEvent = RoutineAppEvent;
const MAX_BUFFERED_BYTES = 1024 * 1024;

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

// GET /api/events (WebSocket, install token).
export function appEventsRoute(events: AppEvents): UpgradeRoute {
  const wss = tokenSocketServer();
  return {
    pattern: /^\/api\/events$/,
    params: [],
    auth: "token",
    open({ req, socket, head }) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => {});
        const unsubscribe = events.subscribe((event) => {
          if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.terminate();
          else ws.send(JSON.stringify(event));
        });
        ws.on("close", unsubscribe);
      });
    },
  };
}
