import { describe, expect, it } from "vitest";
import { forgetOldTickets } from "./client-storage.ts";

const ORIGIN = "http://127.0.0.1:4750";
const CELL = "01JXYZ0000000000000000ABCD";
const OTHER_CELL = "01JXYZ0000000000000000WXYZ";
const GONE_CELL = "01JXYZ0000000000000000GONE";
const OLD = "AAAAAAAAAAAAAAAAAAAAAA";
const LIVE = "B-B_BBBBBBBBBBBBBBBBBB";

function memoryHost(keys: string[]) {
  const map = new Map(keys.map((key) => [key, "1"]));
  return {
    location: { origin: ORIGIN },
    localStorage: {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (key: string) => void map.delete(key),
    },
    keys: () => [...map.keys()],
  };
}

// The client prefixes its keys with its page URL, every character outside [A-Za-z0-9._-] as "_".
const clientKey = (cell: string, ticket: string, name: string) =>
  `http___127.0.0.1_4750_cells_${cell}_desktop_${ticket}__${name}`;

describe("forgetOldTickets", () => {
  it("removes the keys the client left under the cell's earlier tickets and nothing else", () => {
    const kept = [
      "localdot.token",
      clientKey(CELL, LIVE, "stream_mode"),
      clientKey(OTHER_CELL, OLD, "stream_mode"),
      "universalTouchGamepad_currentProfile",
    ];
    const host = memoryHost([
      clientKey(CELL, OLD, "stream_mode"),
      clientKey(CELL, OLD, "storage_key_migrated"),
      ...kept,
    ]);
    forgetOldTickets(
      { cellId: CELL, livePath: `/cells/${CELL}/desktop/${LIVE}/`, listed: [CELL, OTHER_CELL] },
      host,
    );
    expect(host.keys()).toEqual(kept);
  });

  it("removes every key of a cell the daemon no longer lists", () => {
    const kept = [
      clientKey(CELL, LIVE, "stream_mode"),
      clientKey(OTHER_CELL, OLD, "stream_mode"),
      // Not a cell's client page: left alone.
      "http___127.0.0.1_4750_cells_not-a-cell_desktop_x__stream_mode",
      "http___127.0.0.1_4751_cells_01JXYZ0000000000000000GONE_desktop_x__stream_mode",
    ];
    const host = memoryHost([
      clientKey(GONE_CELL, OLD, "stream_mode"),
      clientKey(GONE_CELL, LIVE, "settings"),
      ...kept,
    ]);
    forgetOldTickets(
      { cellId: CELL, livePath: `/cells/${CELL}/desktop/${LIVE}/`, listed: [CELL, OTHER_CELL] },
      host,
    );
    expect(host.keys()).toEqual(kept);
  });

  it("keeps the current cell's live keys even when the list it was given predates the cell", () => {
    const live = clientKey(CELL, LIVE, "stream_mode");
    const host = memoryHost([live]);
    forgetOldTickets(
      { cellId: CELL, livePath: `/cells/${CELL}/desktop/${LIVE}/`, listed: [] },
      host,
    );
    expect(host.keys()).toEqual([live]);
  });

  it("leaves storage alone when the browser refuses access to it", () => {
    const host = {
      location: { origin: ORIGIN },
      get localStorage(): Storage {
        throw new DOMException("denied", "SecurityError");
      },
    };
    expect(() =>
      forgetOldTickets(
        { cellId: CELL, livePath: `/cells/${CELL}/desktop/${LIVE}/`, listed: [CELL] },
        host,
      ),
    ).not.toThrow();
  });
});
