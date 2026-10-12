import {
  type ExportHost,
  ExportLink,
  type ExportStart,
  ExportsState,
  HostExport,
  ULID_PATTERN,
} from "@localdot/protocol";
import { useSyncExternalStore } from "react";
import type { ApiClient } from "../lib/api.ts";
import { openSocket, type SocketHandle } from "../lib/socket.ts";

export interface HostExportsView {
  // null until the host has answered; one that never answers can't make videos.
  host: ExportHost | null;
  loading?: boolean;
  failed?: boolean;
  // Newest first.
  exports: readonly HostExport[];
}

// The videos the host makes, shared by every page signed in to it: listed once, then kept
// current over a socket while the page is open.
export interface HostExports {
  view(): HostExportsView;
  subscribe(listener: () => void): () => void;
  // Asks the host again, after it could not be reached; also done when the page comes back into
  // view or online.
  refresh(): void;
  start(start: ExportStart): Promise<HostExport>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  // A short-lived address that saves the file without the token.
  link(id: string): Promise<string>;
  dispose(): void;
}

const EMPTY: HostExportsView = { host: null, exports: [], loading: true };

export function hostCanMake(view: HostExportsView): boolean {
  return view.host?.state === "ready";
}

export function createHostExports(
  api: ApiClient,
  connect: typeof openSocket = openSocket,
): HostExports {
  let view = EMPTY;
  let socket: SocketHandle | null = null;
  let disposed = false;
  let asking = false;
  const listeners = new Set<() => void>();
  const set = (next: HostExportsView) => {
    view = next;
    for (const listener of listeners) listener();
  };
  const adopt = (state: ExportsState) => set({ host: state.host, exports: state.exports });
  const merge = (made: HostExport) =>
    set({ ...view, exports: [made, ...view.exports.filter((entry) => entry.id !== made.id)] });
  const id = (value: string) => {
    if (!ULID_PATTERN.test(value)) throw new RangeError("Invalid export.");
    return value;
  };
  const refresh = () => {
    if (disposed || asking || socket) return;
    asking = true;
    void api
      .get<unknown>("/api/exports")
      .then((reply) => {
        if (disposed) return;
        adopt(ExportsState.parse(reply));
        socket = connect({
          url: api.socketUrl("/api/exports/stream"),
          protocols: api.socketProtocols(),
          handlers: {
            onMessage(data) {
              const parsed = ExportsState.safeParse(JSON.parse(data));
              if (parsed.success && !disposed) adopt(parsed.data);
            },
          },
        });
      })
      .catch(() => {
        if (!disposed) set({ ...view, loading: false, failed: true });
      })
      .finally(() => {
        asking = false;
      });
  };
  refresh();
  const again = () => {
    if (document.visibilityState === "visible") refresh();
  };
  document.addEventListener("visibilitychange", again);
  window.addEventListener("online", again);
  return {
    view: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    async start(start) {
      const made = HostExport.parse(await api.post("/api/exports", start));
      merge(made);
      return made;
    },
    async cancel(given) {
      await api.post(`/api/exports/${id(given)}/cancel`);
    },
    async retry(given) {
      merge(HostExport.parse(await api.post(`/api/exports/${id(given)}/retry`)));
    },
    async remove(given) {
      await api.del(`/api/exports/${id(given)}`);
      set({ ...view, exports: view.exports.filter((entry) => entry.id !== given) });
    },
    async link(given) {
      const { href } = ExportLink.parse(await api.post(`/api/exports/${id(given)}/link`));
      return `${api.socketUrl("").replace(/^ws/, "http")}${href}`;
    },
    dispose() {
      disposed = true;
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("online", again);
      socket?.close();
      socket = null;
      listeners.clear();
    },
  };
}

export function useHostExports(store: HostExports): HostExportsView {
  return useSyncExternalStore(store.subscribe, store.view);
}
