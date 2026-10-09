import type { BrainEvent } from "@localdot/protocol";
import { ulid } from "@localdot/protocol";
export interface EventSinkOptions {
  send(events: BrainEvent[], signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
  flushMs?: number;
  heartbeatMs?: number;
}
// One ordered sender, owned by one brain generation. Abort drops unsent events and cancels sends;
// normal close drains final events. Main must pass the send signal to ToolClient.events.
export class EventSink {
  readonly #opts: EventSinkOptions;
  readonly #lifetime = new AbortController();
  readonly #signal = this.#lifetime.signal;
  readonly #bound = new Set<AbortSignal>();
  #queue: BrainEvent[] = [];
  #timer: NodeJS.Timeout | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #sending: Promise<void> = Promise.resolve();
  #message: { id: string; text: string } | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(opts: EventSinkOptions) {
    this.#opts = opts;
    this.#signal.addEventListener("abort", this.#cancel, { once: true });
    if (opts.signal) this.bind(opts.signal);
  }
  bind(signal: AbortSignal): void {
    // All past and future sends share the same lifetime. A signal bound after a send starts
    // must cancel that send and its race too, including while normal close is draining.
    if (signal.aborted) {
      this.#lifetime.abort();
      return;
    }
    if (this.#signal.aborted || this.#bound.has(signal)) return;
    this.#bound.add(signal);
    signal.addEventListener("abort", this.#endLifetime, { once: true });
  }
  #endLifetime = () => this.#lifetime.abort();
  #cancel = () => {
    for (const signal of this.#bound) signal.removeEventListener("abort", this.#endLifetime);
    this.#bound.clear();
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#timer = undefined;
    this.#heartbeat = undefined;
    this.#queue = [];
    this.#message = undefined;
  };
  push(event: BrainEvent): void {
    if (this.#closed || this.#signal.aborted) return;
    this.#queue.push(event);
    this.#timer ??= setTimeout(() => {
      void this.flush();
    }, this.#opts.flushMs ?? 100);
  }
  state(
    state: "thinking" | "acting" | "observing" | "paused" | "error",
    reason?: string,
    detail?: string,
  ): void {
    this.push({
      type: "agent.state",
      data: {
        state,
        ...(reason ? { reason: reason.slice(0, 200) } : {}),
        ...(detail ? { detail: detail.slice(0, 200) } : {}),
      },
    });
  }
  text(delta: string): void {
    if (this.#closed || this.#signal.aborted) return;
    this.#message ??= { id: ulid(), text: "" };
    this.#message.text = (this.#message.text + delta).slice(0, 20000);
    for (let at = 0; at < delta.length; at += 4000)
      this.push({
        type: "message.delta",
        data: { messageId: this.#message.id, text: delta.slice(at, at + 4000) },
      });
  }
  endText(): string | undefined {
    const message = this.#message;
    this.#message = undefined;
    if (this.#signal.aborted || this.#closed || !message?.text.trim()) return;
    this.push({ type: "message.assistant", data: { messageId: message.id, text: message.text } });
    return message.text;
  }
  busy(on: boolean): void {
    if (!on) {
      if (this.#heartbeat) {
        clearInterval(this.#heartbeat);
        this.#heartbeat = undefined;
        this.push({
          type: "heartbeat",
          data: { ongoing: false, everyMs: this.#opts.heartbeatMs ?? 1000 },
        });
      }
      return;
    }
    if (this.#closed || this.#signal.aborted || this.#heartbeat) return;
    const beat = () =>
      this.push({
        type: "heartbeat",
        data: { ongoing: true, everyMs: this.#opts.heartbeatMs ?? 1000 },
      });
    beat();
    this.#heartbeat = setInterval(beat, this.#opts.heartbeatMs ?? 1000);
  }
  flush(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#signal.aborted) {
      this.#cancel();
      return this.#sending;
    }
    const batches: BrainEvent[][] = [];
    while (this.#queue.length) batches.push(this.#queue.splice(0, 256));
    for (const batch of batches)
      this.#sending = this.#sending.then(async () => {
        if (this.#signal.aborted) return;
        let abort!: () => void;
        const cancelled = new Promise<void>((resolve) => {
          abort = resolve;
          this.#signal.addEventListener("abort", abort, { once: true });
        });
        try {
          if (this.#signal.aborted) return;
          await Promise.race([this.#opts.send(batch, this.#signal), cancelled]);
        } catch {
          /* Events are best effort; never log peer error text or block tool work. */
        } finally {
          this.#signal.removeEventListener("abort", abort);
        }
      });
    return this.#sending;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.busy(false);
    this.endText();
    this.#closed = true;
    this.#closing = this.flush().finally(() => {
      this.#lifetime.abort();
      this.#cancel();
    });
    return this.#closing;
  }
}
