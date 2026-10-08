import { afterEach, describe, expect, it } from "vitest";
import {
  isAllowedHost,
  isAllowedOrigin,
  setPublicOrigin,
  tokenFromHeaders,
  WS_TOKEN_PREFIX,
} from "./guard.ts";

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

describe("the public origin", () => {
  afterEach(() => setPublicOrigin(undefined));

  it("accepts only loopback hosts and origins by default", () => {
    expect(isAllowedHost("127.0.0.1:4750", 4750)).toBe(true);
    expect(isAllowedHost("localhost:4750", 4750)).toBe(true);
    expect(isAllowedHost("mac.tailnet.ts.net:4750", 4750)).toBe(false);
    expect(isAllowedOrigin(undefined, 4750)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:4750", 4750)).toBe(true);
    expect(isAllowedOrigin("https://mac.tailnet.ts.net:4750", 4750)).toBe(false);
  });

  it("also accepts exactly the configured HTTPS origin and its host", () => {
    setPublicOrigin("https://mac.tailnet.ts.net:4750");
    expect(isAllowedHost("mac.tailnet.ts.net:4750", 4750)).toBe(true);
    expect(isAllowedOrigin("https://mac.tailnet.ts.net:4750", 4750)).toBe(true);
    expect(isAllowedHost("127.0.0.1:4750", 4750)).toBe(true);
    expect(isAllowedHost("mac.tailnet.ts.net", 4750)).toBe(false);
    expect(isAllowedHost("evil.ts.net:4750", 4750)).toBe(false);
    expect(isAllowedOrigin("http://mac.tailnet.ts.net:4750", 4750)).toBe(false);
    expect(isAllowedOrigin("https://mac.tailnet.ts.net:4751", 4750)).toBe(false);
    expect(isAllowedOrigin("https://mac.tailnet.ts.net.evil.com:4750", 4750)).toBe(false);
  });

  it("uses the bare host for the default HTTPS port", () => {
    setPublicOrigin("https://mac.tailnet.ts.net");
    expect(isAllowedHost("mac.tailnet.ts.net", 4750)).toBe(true);
    expect(isAllowedOrigin("https://mac.tailnet.ts.net", 4750)).toBe(true);
  });

  it("refuses anything but a bare HTTPS origin", () => {
    for (const bad of [
      "http://mac.tailnet.ts.net",
      "https://mac.tailnet.ts.net/path",
      "https://user@mac.tailnet.ts.net",
      "https://mac.tailnet.ts.net?x=1",
      "https://mac.tailnet.ts.net/#a",
      "https://*.ts.net",
      "not a url",
      "",
    ]) {
      expect(() => setPublicOrigin(bad), bad).toThrow(/LOCALDOT_PUBLIC_ORIGIN/);
    }
  });
});
