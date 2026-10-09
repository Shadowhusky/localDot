import { setTimeout as sleep } from "node:timers/promises";
import { clipText, type EventDraft, type KeydAsk, type KeydEvent } from "@localdot/protocol";
import type { EventLog } from "../event-log.ts";
import type { LiveSessions } from "../gateway/live.ts";
import type { KeydClient } from "./client.ts";

export interface KeydEventRouterDeps {
  keyd: Pick<KeydClient, "events">;
  live: Pick<LiveSessions, "get">;
  eventLog: Pick<EventLog, "append">;
  ask?(cellId: string, ask: KeydAsk): void;
  // Some events, held connections among them perhaps, were dropped; their owner lists them again.
  asksMissed?(): void;
  perCellPerSecond?: number;
  retryMs?: { min: number; max: number };
  now?: () => number;
}

interface Window {
  second: number;
  count: number;
  dropped: number;
}

// The session log is a bounded view of keyd's audit. Only a currently live
// session receives cell events; the credential service keeps the full audit.
export class KeydEventRouter {
  readonly #limit: number;
  readonly #retry: { min: number; max: number };
  readonly #window = new Map<string, Window>();
  readonly #now: () => number;
  #abort: AbortController | undefined;
  #lost = 0;
  #reportLostAt = 0;

  constructor(private readonly deps: KeydEventRouterDeps) {
    this.#limit = deps.perCellPerSecond ?? 20;
    this.#retry = deps.retryMs ?? { min: 250, max: 5000 };
    this.#now = deps.now ?? (() => performance.now());
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1)
      throw new Error("event limit must be a positive integer");
    if (
      !Number.isFinite(this.#retry.min) ||
      !Number.isFinite(this.#retry.max) ||
      this.#retry.min <= 0 ||
      this.#retry.max < this.#retry.min
    )
      throw new Error("event retry delays must be positive and ordered");
  }

  start(): void {
    if (this.#abort) return;
    const abort = new AbortController();
    this.#abort = abort;
    void this.#follow(abort);
  }

  async #follow(abort: AbortController): Promise<void> {
    let delay = this.#retry.min;
    while (!abort.signal.aborted) {
      const opened = this.#now();
      try {
        await this.deps.keyd.events((event) => {
          // A stale stream cannot append after stop/start, even if its client
          // delivers a callback already queued when the abort arrived.
          if (this.#abort === abort && !abort.signal.aborted) this.route(event);
        }, abort.signal);
      } catch {
        // The monitor reports availability; connection errors may contain data.
      }
      if (abort.signal.aborted) return;
      if (this.#now() - opened >= this.#retry.max) delay = this.#retry.min;
      await sleep(delay, undefined, { signal: abort.signal }).catch(() => {});
      delay = Math.min(delay * 2, this.#retry.max);
    }
  }

  stop(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    for (const [cell, window] of this.#window) this.#report(cell, window);
    this.#window.clear();
    this.#reportLost(true);
  }

  route(event: KeydEvent): void {
    const second = Math.floor(this.#now() / 1000);
    // Retired cells must not accumulate buckets for the lifetime of the daemon.
    for (const [cell, window] of this.#window) {
      if (window.second !== second) {
        this.#report(cell, window);
        this.#window.delete(cell);
      }
    }
    this.#reportLost();
    if (event.type === "events.dropped") {
      this.#lost = Math.min(Number.MAX_SAFE_INTEGER, this.#lost + event.data.count);
      this.#reportLost();
      this.deps.asksMissed?.();
      return;
    }
    // A held connection waits for its answer whether or not a task is live on the cell.
    if (event.type === "egress.ask") {
      this.deps.ask?.(event.cell, event.data);
      return;
    }
    const sessionId = this.deps.live.get(event.cell);
    if (!sessionId) return;
    let window = this.#window.get(event.cell);
    if (!window) {
      window = { second, count: 0, dropped: 0 };
      this.#window.set(event.cell, window);
    }
    if (window.count >= this.#limit) {
      window.dropped++;
      return;
    }
    window.count++;
    const draft: EventDraft =
      event.type === "key.use"
        ? {
            type: "key.use",
            agent: "keyd",
            data: {
              secretId: eventText(event.data.secretId, 64),
              host: eventText(event.data.host, 255),
              method: eventText(event.data.method, 16),
              path: eventText(event.data.path, 512),
              decision: event.data.decision,
            },
          }
        : {
            type: "budget.exceeded",
            agent: "keyd",
            data: {
              ...event.data,
              ...(event.data.taskId === undefined
                ? {}
                : { taskId: eventText(event.data.taskId, 128) }),
            },
          };
    try {
      this.deps.eventLog.append(sessionId, draft);
    } catch {
      console.error("keyd event could not be appended to its session");
    }
  }

  #report(cell: string, window: Window): void {
    if (window.dropped)
      console.warn(
        `keyd: ${window.dropped} events of cell ${eventText(cell, 64)} not logged (more than ${this.#limit}/s)`,
      );
  }

  #reportLost(force = false): void {
    if (!this.#lost || (!force && this.#now() < this.#reportLostAt)) return;
    console.warn(`keyd: ${this.#lost} events dropped; its audit log has them`);
    this.#lost = 0;
    this.#reportLostAt = this.#now() + 1000;
  }
}

// clipText counts code points, while the event schema bounds UTF-16 units.
// Keep whole characters and the schema's limit for astral text such as emoji.
function eventText(text: string, max: number): string {
  const clean = clipText(text, max);
  if (clean.length <= max) return clean;
  let end = max - 1;
  if (/[\uD800-\uDBFF]/u.test(clean[end - 1] ?? "")) end--;
  return `${clean.slice(0, end)}…`;
}
