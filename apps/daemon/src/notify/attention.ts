import {
  ATTENTION_RANK,
  type AttentionItem,
  type AttentionLevel,
  type AttentionReason,
  compareAttention,
  keyLikePresent,
  type LocalDotEvent,
} from "@localdot/protocol";

const MAX_SESSIONS = 200;
const TASK_CHARS = 80;
const OPEN: ReadonlySet<AttentionLevel> = new Set(["needs_you", "blocked", "failed", "done"]);

// The task's own title (the user's words), fit for a notification: one line, at most 80
// characters, and nothing at all when it looks like it holds a key.
export function taskTitle(text: string | undefined): string | null {
  if (!text) return null;
  const line = text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!line || keyLikePresent(line)) return null;
  return line.length > TASK_CHARS ? `${line.slice(0, TASK_CHARS - 1)}…` : line;
}

// Derives each session's attention from its appended events. One item per session: the newest
// state wins. A key names the session, the reason and the thing asked about (an approval's id,
// generation and revision), so a revised card is a new item and a repeat of the same one is not.
export class AttentionLedger {
  readonly #items = new Map<string, AttentionItem>();
  readonly #tasks = new Map<string, string | null>();
  readonly #expires = new Map<string, number>();
  readonly #routines = new Set<string>();
  readonly #listeners = new Set<(item: AttentionItem) => void>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  observe(sessionId: string, event: LocalDotEvent): void {
    if (event.type === "session.start") {
      this.#tasks.set(sessionId, taskTitle(event.data.title));
      if ("origin" in event.data && event.data.origin) this.#routines.add(sessionId);
    }
    if (event.type === "approval.request") this.#expires.set(sessionId, event.data.expiresAt);
    const next = this.#next(sessionId, this.#items.get(sessionId), event);
    if (next) this.#set(next);
    // A continued task starts a session of its own, so an ended one's title and origin go; a Done
    // or Failed it left stays until seen.
    if (event.type === "session.end") this.#forget(sessionId);
  }

  // The user looked at the session: Done and Failed are read. Needs you and Blocked stay.
  seen(sessionId: string): boolean {
    const item = this.#items.get(sessionId);
    if (!item || (item.level !== "done" && item.level !== "failed")) return false;
    this.#set(this.#item(sessionId, "cleared", "none", `seen:${this.#now()}`));
    return true;
  }

  // When the approval a session waits on stops waiting (epoch ms), so a phone push can expire
  // with the card: an unattended routine's window can be an hour.
  approvalExpiresAt(sessionId: string): number | undefined {
    return this.#items.get(sessionId)?.reason === "approval"
      ? this.#expires.get(sessionId)
      : undefined;
  }

  // A session a routine or a follow-up started: its results are told through routine.run.
  isRoutine(sessionId: string): boolean {
    return this.#routines.has(sessionId);
  }

  current(sessionId: string): AttentionItem | undefined {
    return this.#items.get(sessionId);
  }

  snapshot(): AttentionItem[] {
    return [...this.#items.values()]
      .filter((item) => OPEN.has(item.level))
      .sort((a, b) => compareAttention(a.level, b.level) || b.at - a.at);
  }

  subscribe(listener: (item: AttentionItem) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #next(
    sessionId: string,
    current: AttentionItem | undefined,
    event: LocalDotEvent,
  ): AttentionItem | undefined {
    const item = (reason: AttentionReason, level: AttentionLevel, id: string) =>
      this.#item(sessionId, reason, level, id);
    const waitingOn = (reason: AttentionReason, id: string) =>
      current?.reason === reason && current.key.startsWith(`${sessionId}:${reason}:${id}:`);
    const settled = current && ["blocked", "done", "failed"].includes(current.level);
    switch (event.type) {
      case "approval.request": {
        const { approvalId, generation, revision } = event.data;
        return item("approval", "needs_you", `${approvalId}:${generation}:${revision}`);
      }
      case "approval.resolve":
        return waitingOn("approval", event.data.approvalId)
          ? item("working", "working", String(event.seq))
          : undefined;
      case "ask.request":
        return item("ask", "needs_you", `${event.data.askId}:0`);
      case "ask.answer":
        return waitingOn("ask", event.data.askId)
          ? item("working", "working", String(event.seq))
          : undefined;
      case "takeover.request":
        // The user took the computer themselves: they are already there.
        return event.data.by === "user"
          ? undefined
          : item("takeover", "needs_you", `${event.data.requestId}:0`);
      case "takeover.end":
        return waitingOn("takeover", event.data.requestId)
          ? item("working", "working", String(event.seq))
          : undefined;
      case "budget.exceeded":
        return item("budget", "blocked", String(event.seq));
      case "agent.state":
        if (event.data.state === "done") return item("done", "done", String(event.seq));
        if (event.data.state === "idle" && event.data.reason === "gave up")
          return item("gave_up", "failed", String(event.seq));
        if (["thinking", "acting", "observing"].includes(event.data.state) && settled)
          return item("working", "working", String(event.seq));
        return undefined;
      case "message.user":
        return settled ? item("working", "working", String(event.seq)) : undefined;
      case "session.end":
        if (event.data.reason === "error")
          return current?.level === "failed"
            ? undefined
            : item("error", "failed", String(event.seq));
        // A finished or stopped task can no longer be answered, so what it waited on goes. Done
        // and Failed stay until the user has seen them.
        return current && current.level !== "done" && current.level !== "failed"
          ? item("cleared", "none", String(event.seq))
          : undefined;
      default:
        return undefined;
    }
  }

  #item(
    sessionId: string,
    reason: AttentionReason,
    level: AttentionLevel,
    id: string,
  ): AttentionItem {
    return {
      key: `${sessionId}:${reason}:${id}`,
      sessionId,
      level,
      reason,
      task: this.#tasks.get(sessionId) ?? null,
      at: this.#now(),
    };
  }

  #set(item: AttentionItem): void {
    const id = item.sessionId ?? "";
    const before = this.#items.get(id);
    if (before?.key === item.key) return;
    if (item.level === "none") {
      this.#items.delete(id);
      this.#expires.delete(id);
    } else {
      this.#items.delete(id);
      this.#items.set(id, item);
      this.#evict();
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(item);
      } catch {
        console.error("an attention listener failed");
      }
    }
  }

  #evict(): void {
    for (const [id, item] of this.#items) {
      if (this.#items.size <= MAX_SESSIONS) return;
      if (ATTENTION_RANK[item.level] < ATTENTION_RANK.needs_you) {
        this.#items.delete(id);
        this.#forget(id);
      }
    }
  }

  #forget(sessionId: string): void {
    this.#tasks.delete(sessionId);
    this.#expires.delete(sessionId);
    this.#routines.delete(sessionId);
  }
}
