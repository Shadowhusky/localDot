import type { Context } from "@deepseek-ai/cordis";
import {
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  SessionLogOffset,
} from "@deepseek-ai/dsh-session";
import SessionPersistence, {
  assertContiguous,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  type SessionAccess,
  type SessionHandle,
  type SessionPersistenceCreateOptions,
  SessionPersistenceRevision,
  validateStoredEvents,
} from "@deepseek-ai/dsh-session-persistence";

export interface HarnessJournal {
  records: readonly { sessionId: string; event: unknown }[];
  append(sessionId: string, event: unknown): Promise<void>;
}
type Stored = { header: SessionHeader; inherited: number; events: SessionEvent[]; owned: boolean };

// The daemon's generation-fenced, redacted, fsynced journal is the storage backend.
// Brain containers get no host filesystem or credential-store access. Upstream's
// agent factory owns binding, crash-tail repair, resume and child lifecycle.
export class HarnessStorage extends SessionPersistence {
  private stored = new Map<string, Stored>();
  private writes = Promise.resolve();
  private writers = new Map<string, SessionHandle>();
  constructor(
    ctx: Context,
    private readonly journal: HarnessJournal,
  ) {
    super(ctx);
    ctx.on("session/event", (session, event) => {
      const writer = this.writers.get(session.id);
      if (writer)
        void writer.append([event]).catch((error) => {
          this.writes = Promise.reject(error);
          void this.writes.catch(() => {});
        });
    });
    ctx.on("session/flush", () => this.flush());
    for (const record of journal.records) {
      const value = record.event as { type?: string; header?: SessionHeader; inherited?: number };
      if (value?.type === "localdot/harness-header" && value.header) {
        const header = materializeCreateHeader(value.header);
        assertVersion(header);
        const inherited = value.inherited ?? 0;
        if (
          !Number.isSafeInteger(inherited) ||
          inherited < 0 ||
          (!header.isSeeded && inherited !== 0)
        )
          throw new Error("Invalid inherited event count");
        const existing = this.stored.get(record.sessionId);
        if (
          header.id !== record.sessionId ||
          (existing &&
            (JSON.stringify(existing.header) !== JSON.stringify(header) ||
              existing.inherited !== inherited))
        )
          throw new Error("Conflicting harness header");
        if (existing) continue;
        this.stored.set(record.sessionId, {
          header,
          inherited,
          events: [],
          owned: false,
        });
      } else {
        const stored = this.stored.get(record.sessionId);
        if (!stored) throw new Error("Harness event is missing its header");
        const [event] = materializeAppendBatch([record.event as SessionEvent]);
        if (!event) throw new Error("Missing harness event");
        const existing = stored.events[event.seq];
        if (existing && JSON.stringify(existing) === JSON.stringify(event)) continue;
        assertContiguous(stored.header.id, [event], stored.events.length);
        stored.events.push(event);
      }
    }
    for (const stored of this.stored.values()) validateStoredEvents(stored.header, stored.events);
  }
  private write(id: string, value: unknown) {
    this.writes = this.writes.then(() => this.journal.append(id, value));
    // Keep rejection observed until the next mandatory checkpoint propagates it.
    void this.writes.catch(() => {});
    return this.writes;
  }
  async create(
    input: SessionHeader,
    options?: SessionPersistenceCreateOptions,
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const header = materializeCreateHeader(input);
    assertVersion(header);
    if (this.stored.has(header.id)) throw new Error("Harness session already exists");
    const inherited = options?.inheritedEventCount ?? 0;
    if (!Number.isSafeInteger(inherited) || inherited < 0 || (!header.isSeeded && inherited !== 0))
      throw new Error("Invalid inherited event count");
    const stored: Stored = { header, inherited, events: [], owned: false };
    this.stored.set(header.id, stored);
    await this.write(header.id, { type: "localdot/harness-header", header, inherited });
    return this.open(header.id, "write", options);
  }
  async open(
    id: SessionId,
    access: SessionAccess,
    options?: { signal?: AbortSignal },
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const stored = this.stored.get(id);
    if (!stored) throw new Error("Harness session not found");
    if (access === "write" && stored.owned) throw new Error("Harness session already owned");
    if (access === "write") stored.owned = true;
    let closed = false;
    const check = (writing = false) => {
      if (closed || (writing && access !== "write")) throw new Error("Harness handle unavailable");
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await this.flush();
      } finally {
        if (access === "write") {
          stored.owned = false;
          this.writers.delete(id);
        }
      }
    };
    const handle: SessionHandle = {
      id,
      header: stored.header,
      inheritedEventCount: SessionLogOffset(stored.inherited),
      access,
      read: async (offset = 0, length = stored.events.length, options) => {
        options?.signal?.throwIfAborted();
        check();
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(length) ||
          length < 0
        )
          throw new Error("Invalid harness event slice");
        return {
          eventState: "shared-frozen",
          events: stored.events.slice(offset, offset + length),
        };
      },
      append: async (events, options) => {
        options?.signal?.throwIfAborted();
        check(true);
        const batch = materializeAppendBatch(events);
        assertContiguous(id, batch, stored.events.length);
        stored.events.push(...batch);
        for (const event of batch) this.write(id, event);
        await this.flush();
      },
      flush: async (options) => {
        options?.signal?.throwIfAborted();
        check(true);
        await this.flush();
      },
      close,
      [Symbol.asyncDispose]: close,
    };
    if (access === "write") this.writers.set(id, handle);
    return handle;
  }
  async flush() {
    await this.writes;
  }
  events(id: string): readonly SessionEvent[] {
    return this.stored.get(id)?.events ?? [];
  }
  async stat(id: SessionId, options?: { signal?: AbortSignal }) {
    options?.signal?.throwIfAborted();
    const stored = this.stored.get(id);
    if (!stored) return undefined;
    return {
      header: stored.header,
      eventCount: stored.events.length,
      revision: SessionPersistenceRevision(`${id}:${stored.events.length}`),
    };
  }
  async list(options?: { signal?: AbortSignal }) {
    options?.signal?.throwIfAborted();
    return [...this.stored.values()].map((stored) => ({
      header: stored.header,
      eventCount: stored.events.length,
      revision: SessionPersistenceRevision(`${stored.header.id}:${stored.events.length}`),
    }));
  }
}
