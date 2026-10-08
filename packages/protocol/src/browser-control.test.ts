import { describe, expect, it } from "vitest";
import {
  BrowserActionPermit,
  BrowserControlReply,
  BrowserControlRequest,
} from "./browser-control.ts";

const identity = {
  browserCellId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
  parentCellId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0M",
  instance: "87ae386e-79f1-4f3e-b604-869812515446",
  revision: 1,
  requestId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0K",
};
const owner = { sessionId: identity.requestId, generation: 1 };

describe("browser authority wire schemas", () => {
  it("accepts only the two explicit authority transitions", () => {
    expect(BrowserControlRequest.parse({ ...identity, holder: "user" })).toEqual({
      ...identity,
      holder: "user",
    });
    expect(BrowserControlRequest.parse({ ...identity, holder: "agent", owner })).toEqual({
      ...identity,
      holder: "agent",
      owner,
    });
    expect(BrowserActionPermit.parse({ ...identity, owner })).toEqual({ ...identity, owner });
  });

  it.each([
    { holder: "agent" },
    { holder: "user", owner },
    { holder: "agent", owner, method: "Runtime.evaluate" },
    { holder: "agent", owner: { ...owner, cookies: "token" } },
    { holder: "agent", owner: { ...owner, generation: 0 } },
    { holder: "agent", owner, revision: 0 },
    { holder: "agent", owner, revision: 1.5 },
    { holder: "agent", owner, revision: Number.MAX_SAFE_INTEGER + 1 },
    { holder: "agent", owner, revision: "1" },
    { holder: "agent", owner, instance: "old-browser" },
    { holder: "agent", owner, requestId: "../../profile" },
  ])("refuses malformed, ambiguous, and extended commands %#", (changes) => {
    expect(BrowserControlRequest.safeParse({ ...identity, ...changes }).success).toBe(false);
  });

  it("forbids method selection and non-agent permit identities", () => {
    expect(BrowserActionPermit.safeParse({ ...identity }).success).toBe(false);
    expect(BrowserActionPermit.safeParse({ ...identity, owner, holder: "user" }).success).toBe(
      false,
    );
    expect(BrowserActionPermit.safeParse({ ...identity, owner, eval: "1" }).success).toBe(false);
  });

  it("does not carry arbitrary browser response fields into a control receipt", () => {
    const receipt = { ...identity, holder: "agent", reloaded: 0, selectionsCleared: true };
    expect(BrowserControlReply.parse(receipt)).toEqual(receipt);
    expect(BrowserControlReply.safeParse({ ...receipt, cookies: "private" }).success).toBe(false);
    expect(BrowserControlReply.safeParse({ ...receipt, reloaded: 257 }).success).toBe(false);
  });
});
