import { randomBytes, timingSafeEqual } from "node:crypto";

export function newCellToken(): string {
  return randomBytes(32).toString("base64url");
}

export const TICKET_PATTERN = /^[A-Za-z0-9_-]{22}$/;

// A stream ticket lets the Selkies iframe, which can carry no Authorization header, open one
// cell's stream path (P2-R2): one live ticket per cell and access scope, 128 random bits, kept in memory only (a
// daemon restart revokes every ticket), compared in constant time, never logged. The ticket itself
// is kept so the API can hand the same one back while the cell stays ready.
export class TicketRegistry {
  readonly #tickets = new Map<
    string,
    { cell: string; scope?: string; token: string; valid?: () => boolean }
  >();
  readonly #listeners = new Set<(token: string, reason: "cell" | "scope") => void>();
  issue(cellId: string, scope?: string, valid?: () => boolean): string {
    const key = `${cellId}:${scope ?? "owner"}`;
    const live = this.#tickets.get(key);
    if (live && (!live.valid || live.valid())) return live.token;
    const token = randomBytes(16).toString("base64url");
    this.#tickets.set(key, { cell: cellId, scope, valid, token });
    return token;
  }
  resolve(ticket: string): string | undefined {
    if (!TICKET_PATTERN.test(ticket)) return;
    for (const live of this.#tickets.values()) {
      if (
        timingSafeEqual(Buffer.from(ticket), Buffer.from(live.token)) &&
        (!live.valid || live.valid())
      )
        return live.cell;
    }
  }
  hasLiveTicket(cellId: string): boolean {
    return [...this.#tickets.values()].some(
      (live) => live.cell === cellId && (!live.valid || live.valid()),
    );
  }
  onRevoke(fn: (token: string, reason: "cell" | "scope") => void) {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }
  #drop(test: (live: { cell: string; scope?: string }) => boolean, reason: "cell" | "scope") {
    for (const [key, live] of this.#tickets)
      if (test(live)) {
        this.#tickets.delete(key);
        for (const fn of this.#listeners) fn(live.token, reason);
      }
  }
  revoke(cellId: string): void {
    this.#drop((live) => live.cell === cellId, "cell");
  }
  revokeScope(scope: string): void {
    this.#drop((live) => live.scope === scope, "scope");
  }
}
