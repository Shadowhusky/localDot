export interface ClientStorageHost {
  location: { origin: string };
  localStorage: Pick<Storage, "length" | "key" | "removeItem">;
}

// Selkies' client keys what it stores by its page URL, ticket included, every character outside
// [A-Za-z0-9._-] replaced by "_" (S8). Each ticket a cell is given leaves a set in this origin's
// storage; when a new one is minted, the sets of the cell's earlier tickets are dropped.
export function forgetOldTickets(
  cellId: string,
  livePath: string,
  host: ClientStorageHost = window,
): void {
  try {
    const { origin } = host.location;
    const cellPrefix = clientPrefix(`${origin}/cells/${cellId}/desktop/`);
    const livePrefix = clientPrefix(`${origin}${livePath}`);
    const storage = host.localStorage;
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(cellPrefix) && !key.startsWith(livePrefix)) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    // Storage the browser refuses holds nothing of the client's either.
  }
}

const clientPrefix = (url: string) => url.replace(/[^a-zA-Z0-9._-]/g, "_");
