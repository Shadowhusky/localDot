import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "./session.ts";

function fixture() {
  return new AgentSession(ulid(), ulid(), "Fixture task", { append: vi.fn() });
}

describe("idle wait cancellation", () => {
  it("rejects an already canceled external wait without ending the session", async () => {
    const session = fixture(),
      abort = new AbortController(),
      reason = new Error("Fixture account changed");
    abort.abort(reason);
    await expect(session.waitForUser(15, abort.signal)).rejects.toBe(reason);
    expect(session.stopped).toBe(false);
  });
  it("rejects cancellation of a pending external wait", async () => {
    const session = fixture(),
      abort = new AbortController(),
      reason = new Error("Fixture account changed");
    const wait = session.waitForUser(15, abort.signal);
    abort.abort(reason);
    await expect(wait).rejects.toBe(reason);
    expect(session.stopped).toBe(false);
  });
  it("checks external cancellation before an unread message fast path", async () => {
    const session = fixture(),
      abort = new AbortController(),
      reason = new Error("Fixture account changed");
    session.post("followup", "Keep this pending");
    abort.abort(reason);
    await expect(session.waitForUser(15, abort.signal)).rejects.toBe(reason);
    expect(session.delivered).toBe(0);
  });
  it("retains the ordinary session Stop result", async () => {
    const session = fixture();
    const wait = session.waitForUser(100);
    session.stop();
    await expect(wait).resolves.toBe(false);
  });
  it("wakes for an ordinary message while an external signal is active", async () => {
    const session = fixture(),
      abort = new AbortController();
    const wait = session.waitForUser(100, abort.signal);
    session.post("followup", "Continue");
    await expect(wait).resolves.toBe(true);
    expect(session.stopped).toBe(false);
  });
});
