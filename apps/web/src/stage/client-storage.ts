export interface ClientStorageHost {
  location: { origin: string };
  localStorage: Pick<Storage, "length" | "key" | "removeItem">;
}

export interface TicketScope {
  // The cell a ticket was just minted for, and that ticket's page path.
  cellId: string;
  livePath: string;
  // Every cell id the daemon listed last.
  listed: readonly string[];
}

// Selkies' client keys what it stores by its page URL, ticket included, every character outside
// [A-Za-z0-9._-] replaced by "_" (S8). Each ticket a cell is given leaves a set in this origin's
// storage. When a new one is minted, the sets of the cell's earlier tickets are dropped, and so is
// everything stored for a cell the daemon no longer lists.
export function forgetOldTickets(
  { cellId, livePath, listed }: TicketScope,
  host: ClientStorageHost = window,
): void {
  try {
    const { origin } = host.location;
    const cellsPrefix = clientPrefix(`${origin}/cells/`);
    const livePrefix = clientPrefix(`${origin}${livePath}`);
    const keep = new Set([...listed, cellId]);
    const storage = host.localStorage;
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key?.startsWith(cellsPrefix)) continue;
      const id = CLIENT_PAGE.exec(key.slice(cellsPrefix.length))?.[1];
      if (id === undefined) continue;
      if (!keep.has(id) || (id === cellId && !key.startsWith(livePrefix))) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    // Storage the browser refuses holds nothing of the client's either.
  }
}

// What follows "<origin>/cells/" in a client key: a cell id (a ULID), then its desktop path.
const CLIENT_PAGE = /^([0-9A-Z]{26})_(?:desktop|browser)_/;
const clientPrefix = (url: string) => url.replace(/[^a-zA-Z0-9._-]/g, "_");
