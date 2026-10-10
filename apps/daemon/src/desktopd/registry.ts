import type {
  BrowserSecretReply,
  BrowserSecretRequest,
} from "../../../../packages/protocol/src/browser-secret.ts";
import type { CellApi } from "../cells/orchestrator.ts";
import type { Clock } from "../clock.ts";
import { DesktopdClient } from "./client.ts";
import { ClockMap } from "./clock-map.ts";

export interface NativeDevice {
  client: Pick<
    DesktopdClient,
    "clock" | "input" | "settle" | "observe" | "focused" | "hitTest" | "find" | "type"
  > &
    Partial<Pick<DesktopdClient, "zoom" | "release" | "held">>;
  secret?(request: BrowserSecretRequest, signal: AbortSignal): Promise<BrowserSecretReply>;
  clocks: ClockMap;
  // How long this device's element lookups may take, when not desktopd's: it ends them by then.
  lookupMs?: number;
}

export interface CellDesktopd extends NativeDevice {
  client: DesktopdClient;
}

// One client and clock map per cell, rebuilt whenever the published port changes (every start)
// and dropped when the cell leaves ready, so a stopped or removed cell keeps no sync timer.
export class DesktopdRegistry {
  readonly #byUrl = new Map<string, CellDesktopd>();
  readonly #unsubscribe: () => void;

  constructor(
    private readonly cells: CellApi,
    private readonly clock: Clock,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.#unsubscribe = cells.subscribe((cell) => {
      if (cell.state !== "ready" || cell.paused) this.#forget(cell.id);
    });
  }

  for(cellId: string): CellDesktopd | undefined {
    if (this.cells.get(cellId)?.paused) return undefined;
    const endpoint = this.cells.endpoints(cellId)?.desktopd;
    if (!endpoint) return undefined;
    const key = `${cellId} ${endpoint.baseUrl}`;
    let entry = this.#byUrl.get(key);
    if (!entry) {
      this.#forget(cellId);
      const client = new DesktopdClient(endpoint, this.fetchImpl);
      const clocks = new ClockMap(
        async () => (await client.clock()).mono,
        () => this.clock.nowMicros(),
      );
      clocks.start();
      entry = { client, clocks };
      this.#byUrl.set(key, entry);
    }
    return entry;
  }

  dispose(): void {
    this.#unsubscribe();
    for (const entry of this.#byUrl.values()) entry.clocks.stop();
    this.#byUrl.clear();
  }

  #forget(cellId: string): void {
    for (const [k, old] of this.#byUrl) {
      if (k.startsWith(`${cellId} `)) {
        old.clocks.stop();
        this.#byUrl.delete(k);
      }
    }
  }
}
