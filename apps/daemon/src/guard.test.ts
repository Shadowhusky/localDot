import { describe, expect, it } from "vitest";
import { tokenFromHeaders, WS_TOKEN_PREFIX } from "./guard.ts";

const TOKEN = "t".repeat(43);

describe("tokenFromHeaders", () => {
  it("reads a bearer token", () => {
    expect(tokenFromHeaders({ authorization: `Bearer ${TOKEN}` })).toBe(TOKEN);
  });

  it("reads the token from the websocket subprotocol list", () => {
    expect(WS_TOKEN_PREFIX).toBe("localdot.token.");
    const protocols = `localdot.v1, localdot.token.${TOKEN}`;
    expect(tokenFromHeaders({ "sec-websocket-protocol": protocols })).toBe(TOKEN);
  });

  it("ignores other subprotocols", () => {
    expect(tokenFromHeaders({ "sec-websocket-protocol": "localdot.v1, chat" })).toBeUndefined();
    const lookalike = `x${WS_TOKEN_PREFIX}${TOKEN}`;
    expect(tokenFromHeaders({ "sec-websocket-protocol": lookalike })).toBeUndefined();
  });

  it("prefers the bearer token", () => {
    const headers = {
      authorization: "Bearer from-bearer",
      "sec-websocket-protocol": "localdot.v1, localdot.token.from-protocol",
    };
    expect(tokenFromHeaders(headers)).toBe("from-bearer");
  });
});
