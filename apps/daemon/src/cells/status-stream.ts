import { ULID_PATTERN } from "@localdot/protocol";
import { refuse, tokenSocketServer, type UpgradeRoute } from "../upgrade-router.ts";
import type { CellApi } from "./orchestrator.ts";
import type { CellSummary } from "./types.ts";

// Each message is a whole summary, so a client too slow to keep up loses nothing by being cut off:
// it reconnects and starts again from the current state.
const MAX_BUFFERED_BYTES = 1024 * 1024;

export interface StatusSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
  on(event: "close" | "error", listener: () => void): void;
}

export function cellStatusRoute(cells: CellApi): UpgradeRoute {
  const wss = tokenSocketServer();
  return {
    pattern: /^\/api\/cells\/([^/]+)\/status$/,
    params: ["id"],
    auth: "token",
    open({ req, socket, head, params }) {
      const id = params.id ?? "";
      if (!ULID_PATTERN.test(id)) {
        refuse(socket, "403 Forbidden");
        return;
      }
      const current = cells.get(id);
      if (!current) {
        refuse(socket, "404 Not Found");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => followCell(ws, cells, current));
    },
  };
}

export function followCell(ws: StatusSocket, cells: CellApi, current: CellSummary): void {
  const send = (cell: CellSummary) => {
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.terminate();
    else ws.send(JSON.stringify(cell));
  };
  ws.on("error", () => {});
  send(current);
  const unsubscribe = cells.subscribe((cell) => {
    if (cell.id !== current.id) return;
    send(cell);
    if (cell.state === "removed") ws.close(1000, "cell removed");
  });
  ws.on("close", unsubscribe);
}
