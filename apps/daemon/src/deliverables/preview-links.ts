import { randomBytes, timingSafeEqual } from "node:crypto";
import { PREVIEW_TICKET } from "@localdot/protocol";

const IDLE_MS = 30 * 60 * 1000;
const MAX_MS = 8 * 60 * 60 * 1000;
const MAX_LINKS = 256;

interface Link {
  sessionId: string;
  created: number;
  used: number;
}

// A preview link carries no install token, so a page frame, a picture or a player can load one
// task's files by address: 256 random bits for one task, kept in memory only, lapsing after 30
// minutes unused and 8 hours at most.
export class PreviewLinks {
  readonly #links = new Map<string, Link>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(sessionId: string): string {
    const now = this.#now();
    this.#prune(now);
    for (const [ticket, link] of this.#links)
      if (link.sessionId === sessionId && link.created + MAX_MS - IDLE_MS > now) {
        link.used = now;
        return ticket;
      }
    if (this.#links.size >= MAX_LINKS) {
      const oldest = this.#links.keys().next().value;
      if (oldest !== undefined) this.#links.delete(oldest);
    }
    const ticket = randomBytes(32).toString("base64url");
    this.#links.set(ticket, { sessionId, created: now, used: now });
    return ticket;
  }

  resolve(ticket: string): string | undefined {
    if (!PREVIEW_TICKET.test(ticket)) return undefined;
    const given = Buffer.from(ticket);
    const now = this.#now();
    for (const [live, link] of this.#links) {
      if (!timingSafeEqual(given, Buffer.from(live))) continue;
      if (!this.#alive(link, now)) return undefined;
      link.used = now;
      return link.sessionId;
    }
    return undefined;
  }

  #alive(link: Link, now: number): boolean {
    return link.used + IDLE_MS > now && link.created + MAX_MS > now;
  }

  #prune(now: number): void {
    for (const [ticket, link] of this.#links)
      if (!this.#alive(link, now)) this.#links.delete(ticket);
  }
}
