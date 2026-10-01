import { ULID_PATTERN } from "@localdot/protocol";
import { refuse, tokenSocketServer, type UpgradeRoute } from "../upgrade-router.ts";
import type { CellApi } from "./orchestrator.ts";

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
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => {});
        ws.send(JSON.stringify(current));
        const unsubscribe = cells.subscribe((cell) => {
          if (cell.id !== id) return;
          ws.send(JSON.stringify(cell));
          if (cell.state === "removed") ws.close(1000, "cell removed");
        });
        ws.on("close", unsubscribe);
      });
    },
  };
}
