import { describe, expect, it } from "vitest";
import { PresenceBoard } from "./presence.ts";

describe("this Mac's own page", () => {
  it("is where a banner's click goes: the address it was last opened at here, never another device's", () => {
    const board = new PresenceBoard();
    expect(board.localOrigin()).toBeUndefined();
    board.connect(true, "http://localhost:4750");
    board.connect(false, "https://mac.tailnet.ts.net");
    expect(board.localOrigin()).toBe("http://localhost:4750");
    board.connect(true, "http://127.0.0.1:4750").close();
    expect(board.localOrigin()).toBe("http://127.0.0.1:4750");
  });
});
