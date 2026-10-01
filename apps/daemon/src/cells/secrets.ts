import { randomBytes, timingSafeEqual } from "node:crypto";

export function newCellToken(): string {
  return randomBytes(32).toString("base64url");
}

export const TICKET_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// A stream ticket lets the Selkies iframe, which can carry no Authorization header, open one
// cell's stream path (P2-R2): one live ticket per cell, 128 random bits, kept in memory only (a
// daemon restart revokes every ticket), compared in constant time, never logged. The ticket itself
// is kept so the API can hand the same one back while the cell stays ready.
export class TicketRegistry {
  readonly #byCell = new Map<string, string>();

  issue(cellId: string): string {
    const live = this.#byCell.get(cellId);
    if (live !== undefined) return live;
    const ticket = randomBytes(16).toString("base64url");
    this.#byCell.set(cellId, ticket);
    return ticket;
  }

  resolve(ticket: string): string | undefined {
    if (!TICKET_PATTERN.test(ticket)) return undefined;
    const given = Buffer.from(ticket);
    for (const [cellId, live] of this.#byCell) {
      if (timingSafeEqual(given, Buffer.from(live))) return cellId;
    }
    return undefined;
  }

  revoke(cellId: string): void {
    this.#byCell.delete(cellId);
  }
}
