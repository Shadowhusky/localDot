import { describe, expect, it } from "vitest";
import { forgetOldTickets } from "./client-storage.ts";

const ORIGIN = "http://127.0.0.1:4750";
const CELL = "01JXYZ0000000000000000ABCD";
const OTHER_CELL = "01JXYZ0000000000000000WXYZ";
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
    forgetOldTickets(CELL, `/cells/${CELL}/desktop/${LIVE}/`, host);
    expect(host.keys()).toEqual(kept);
  });

  it("leaves storage alone when the browser refuses access to it", () => {
    const host = {
      location: { origin: ORIGIN },
      get localStorage(): Storage {
        throw new DOMException("denied", "SecurityError");
      },
    };
    expect(() => forgetOldTickets(CELL, `/cells/${CELL}/desktop/${LIVE}/`, host)).not.toThrow();
  });
});
