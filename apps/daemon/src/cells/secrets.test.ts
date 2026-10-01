import { randomBytes, timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { newCellToken, TICKET_PATTERN, TicketRegistry } from "./secrets.ts";

// Pass-through spies: tests can see where tickets come from and how they are compared.
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return {
    ...crypto,
    randomBytes: vi.fn(crypto.randomBytes),
    timingSafeEqual: vi.fn(crypto.timingSafeEqual),
  };
});

const lastCharFlipped = (ticket: string) =>
  `${ticket.slice(0, 21)}${ticket.endsWith("A") ? "B" : "A"}`;

describe("cell secrets", () => {
  it("mints 43-character base64url tokens that differ", () => {
    const a = newCellToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newCellToken()).not.toBe(a);
  });

  it("keeps one live ticket per cell, resolves it, and revokes per cell", () => {
    const tickets = new TicketRegistry();
    const t1 = tickets.issue("cell-a");
    const t2 = tickets.issue("cell-b");
    expect(t1).toMatch(TICKET_PATTERN);
    expect(tickets.issue("cell-a")).toBe(t1);
    expect(tickets.resolve(t1)).toBe("cell-a");
    expect(tickets.resolve(t2)).toBe("cell-b");
    expect(tickets.resolve("nope")).toBeUndefined();
    expect(tickets.resolve(`${t1}x`)).toBeUndefined();
    expect(tickets.resolve(lastCharFlipped(t1))).toBeUndefined();
    tickets.revoke("cell-a");
    expect(tickets.resolve(t1)).toBeUndefined();
    expect(tickets.resolve(t2)).toBe("cell-b");
    expect(tickets.issue("cell-a")).not.toBe(t1);
  });

  it("mints a ticket from 128 bits of the system's secure random source", () => {
    const random = vi.mocked(randomBytes);
    random.mockClear();
    const ticket = new TicketRegistry().issue("cell-a");
    expect(random).toHaveBeenCalledExactlyOnceWith(16);
    const minted = random.mock.results[0]?.value as Buffer | undefined;
    expect(ticket).toBe(minted?.toString("base64url"));
  });

  it("compares a presented ticket with every live one in constant time", () => {
    const tickets = new TicketRegistry();
    const a = tickets.issue("cell-a");
    tickets.issue("cell-b");
    const compare = vi.mocked(timingSafeEqual);
    compare.mockClear();
    expect(tickets.resolve(lastCharFlipped(a))).toBeUndefined();
    expect(compare).toHaveBeenCalledTimes(2);
  });

  it("never writes a ticket to the console", () => {
    const methods = ["debug", "error", "info", "log", "trace", "warn"] as const;
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      const tickets = new TicketRegistry();
      const ticket = tickets.issue("cell-a");
      tickets.issue("cell-a");
      tickets.resolve(ticket);
      tickets.resolve(lastCharFlipped(ticket));
      tickets.resolve("not a ticket");
      tickets.revoke("cell-a");
      tickets.resolve(ticket);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("keeps tickets in memory only, so a daemon restart revokes them all", () => {
    const ticket = new TicketRegistry().issue("cell-a");
    const restarted = new TicketRegistry();
    expect(restarted.resolve(ticket)).toBeUndefined();
    expect(restarted.issue("cell-a")).not.toBe(ticket);
  });
});
