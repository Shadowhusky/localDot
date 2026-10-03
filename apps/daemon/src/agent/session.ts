import {
  type BootConfig,
  type EventDraft,
  InboxItem,
  type InboxReply,
  type TranscriptAppend,
  ulid,
} from "@localdot/protocol";
import type { EventLog } from "../event-log.ts";
import type { TranscriptStore } from "./transcript.ts";

export const AGENT = "main";
export type SessionStatus = "starting" | "running" | "waiting_user" | "paused" | "idle" | "ended";
export interface AskAnswer {
  option?: string;
  text?: string;
  by: "user" | "timeout" | "stop";
}
export interface TakeoverOutcome {
  note?: string;
  by: "user" | "stop";
}
export interface PlanItem {
  id: string;
  text: string;
  status: "todo" | "doing" | "done" | "skipped";
}
export interface BrainGeneration {
  readonly id: number;
  readonly signal: AbortSignal;
}
export interface ToolLease {
  readonly generation: BrainGeneration;
  readonly signal: AbortSignal;
  check(): void;
  finish(): void;
}
interface ActiveCall {
  abort: AbortController;
  settled: Promise<void>;
  finish(): void;
}
interface ControlRecord {
  requestId: string;
  startedByGeneration: number;
  held: boolean;
  released: Promise<TakeoverOutcome>;
  resolve(outcome: TakeoverOutcome): void;
  step?: string;
}
export class SessionStoppedError extends Error {
  constructor() {
    super("the session or agent call is no longer active");
    this.name = "SessionStoppedError";
  }
}
export class ControlHeldError extends Error {
  constructor() {
    super("the user has control of the desktop");
    this.name = "ControlHeldError";
  }
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new SessionStoppedError());
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

// Daemon-owned state outlives any brain or HTTP request. In particular, retirement cancels the
// caller of a takeover but cannot hand the computer back on the user's behalf.
export class AgentSession {
  status: SessionStatus = "starting";
  brainCellId: string | undefined;
  boot: BootConfig | undefined;
  toolToken: string | undefined;
  lastFrameId: string | undefined;
  tainted = false;
  toolCalls = 0;
  plan: PlanItem[] = [];
  readonly abort = new AbortController();
  readonly #inbox: InboxItem[] = [];
  readonly #waiters = new Set<() => void>();
  readonly #active = new Map<ToolLease, ActiveCall>();
  readonly #fetched = new Map<number, InboxItem>();
  #seq = 0;
  #generationId = 0;
  #brain: { generation: BrainGeneration; abort: AbortController } | undefined;
  #delivered = 0;
  #ask:
    | { askId: string; options: string[]; allowText: boolean; finish(a: AskAnswer): boolean }
    | undefined;
  #control: ControlRecord | undefined;

  constructor(
    readonly id: string,
    readonly cellId: string,
    readonly task: string,
    private readonly eventLog: Pick<EventLog, "append">,
  ) {}
  get stopped(): boolean {
    return this.abort.signal.aborted;
  }
  get delivered(): number {
    return this.#delivered;
  }
  get inboxSequence(): number {
    return this.#seq;
  }
  get generation(): BrainGeneration | undefined {
    return this.#brain?.generation;
  }
  get pendingAsk(): string | undefined {
    return this.#ask?.askId;
  }
  get pendingTakeover(): string | undefined {
    return this.#control?.requestId;
  }
  get controlHeld(): boolean {
    return this.#control !== undefined;
  }

  beginBrain(): BrainGeneration {
    if (this.stopped) throw new SessionStoppedError();
    if (this.#control) throw new ControlHeldError();
    if (this.#brain) this.retireBrain(this.#brain.generation);
    const abort = new AbortController();
    const generation = Object.freeze({ id: ++this.#generationId, signal: abort.signal });
    this.#brain = { generation, abort };
    this.#fetched.clear();
    return generation;
  }
  isCurrent(generation: BrainGeneration): boolean {
    return !this.stopped && this.#brain?.generation === generation && !generation.signal.aborted;
  }
  retireBrain(generation: BrainGeneration): void {
    if (this.#brain?.generation !== generation) return;
    const previous = this.#brain;
    this.#brain = undefined;
    this.toolToken = undefined;
    this.boot = undefined;
    this.brainCellId = undefined;
    this.#fetched.clear();
    previous.abort.abort(new SessionStoppedError());
  }
  publishBrain(
    generation: BrainGeneration,
    values: { toolToken: string; boot: BootConfig; brainCellId: string },
  ): void {
    this.check(generation);
    this.toolToken = values.toolToken;
    this.boot = values.boot;
    this.brainCellId = values.brainCellId;
  }
  check(generation: BrainGeneration, signal?: AbortSignal, allowControl = false): void {
    if (!this.isCurrent(generation) || signal?.aborted) throw new SessionStoppedError();
    if (this.#control && !allowControl) throw new ControlHeldError();
  }
  admit(generation: BrainGeneration, requestSignal?: AbortSignal): ToolLease {
    this.check(generation, requestSignal);
    const abort = new AbortController();
    const signal = AbortSignal.any([
      this.abort.signal,
      generation.signal,
      abort.signal,
      ...(requestSignal ? [requestSignal] : []),
    ]);
    let resolve!: () => void;
    const settled = new Promise<void>((r) => {
      resolve = r;
    });
    let finished = false;
    const lease: ToolLease = {
      generation,
      signal,
      check: () => this.check(generation, signal),
      finish: () => {
        if (finished) return;
        finished = true;
        this.#active.delete(lease);
        resolve();
      },
    };
    this.#active.set(lease, { abort, settled, finish: lease.finish });
    return lease;
  }
  append(type: string, data: Record<string, unknown>, step?: string): void {
    this.eventLog.append(this.id, {
      type,
      agent: AGENT,
      ...(step ? { step } : {}),
      data,
    } as unknown as EventDraft);
  }
  post(kind: InboxItem["kind"], text: string): InboxItem {
    if (this.stopped) throw new SessionStoppedError();
    const item = Object.freeze(
      InboxItem.parse({ seq: this.#seq + 1, messageId: ulid(), kind, text }),
    );
    if (kind !== "resume") this.append("message.user", { messageId: item.messageId, text, kind });
    this.#seq = item.seq;
    this.#inbox.push(item);
    if (kind !== "resume") this.tainted = false;
    this.#wake();
    return { ...item };
  }
  async waitForUser(waitMs: number, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
    const unread = () => this.#inbox.some((i) => i.seq > this.#delivered && i.kind !== "resume");
    const deadline = Date.now() + waitMs;
    while (!unread() && !this.stopped && Date.now() < deadline) {
      await this.#changed(deadline - Date.now(), combined);
      signal?.throwIfAborted();
    }
    return unread() && !this.stopped;
  }
  // A paused task may have no live brain after credential retirement. This daemon-owned wait
  // observes explicit Resume without creating a generation, fetching content or acknowledging it.
  async waitForResume(after: number, signal = this.abort.signal): Promise<void> {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.#seq)
      throw new Error("invalid resume cursor");
    const combined = AbortSignal.any([this.abort.signal, signal]);
    while (!this.#inbox.some((item) => item.seq > after && item.kind === "resume")) {
      combined.throwIfAborted();
      await this.#changed(25_000, combined);
    }
    combined.throwIfAborted();
  }
  async inbox(
    after: number,
    waitMs: number,
    signal?: AbortSignal,
    generation = this.generation,
  ): Promise<InboxReply> {
    if (!generation) throw new SessionStoppedError();
    this.check(generation, signal, true);
    if (!Number.isSafeInteger(after) || after < 0 || after > this.#seq)
      throw new Error("invalid inbox cursor");
    const ready = () => this.#inbox.filter((i) => i.seq > after);
    const combined = AbortSignal.any([
      this.abort.signal,
      generation.signal,
      ...(signal ? [signal] : []),
    ]);
    if (!ready().length && waitMs > 0) await this.#changed(Math.min(25_000, waitMs), combined);
    this.check(generation, combined, true);
    const items = ready();
    for (const item of items) this.#fetched.set(item.seq, item);
    return { items: items.map((i) => ({ ...i })), stopped: false };
  }
  // Synchronous storage commits cannot interleave a generation change. Checks between message
  // fsync and acknowledgement still protect injected storage callbacks and explicit Stop.
  appendTranscript(
    store: TranscriptStore,
    generation: BrainGeneration,
    request: TranscriptAppend,
    signal?: AbortSignal,
  ): void {
    this.check(generation, signal, true);
    const state = store.state(this.id);
    this.#delivered = Math.max(this.#delivered, state.inboxAfter);
    for (const message of request.messages) {
      if (!message.sourceInbox) continue;
      const item = this.#fetched.get(message.sourceInbox.seq);
      if (
        !item ||
        item.kind === "resume" ||
        item.messageId !== message.sourceInbox.messageId ||
        message.role !== "user" ||
        message.content !== item.text
      )
        throw new Error("transcript source does not match a fetched user message");
    }
    const after = request.inboxAfter;
    if (after !== undefined && (after < this.#delivered || after > this.#seq))
      throw new Error("invalid acknowledgement cursor");
    const records = new Map(
      state.messages.flatMap((m) => (m.sourceInbox ? [[m.sourceInbox.messageId, m] as const] : [])),
    );
    for (const message of request.messages)
      if (message.sourceInbox) records.set(message.sourceInbox.messageId, message);
    if (after !== undefined)
      for (let seq = this.#delivered + 1; seq <= after; seq++) {
        const item = this.#fetched.get(seq);
        if (!item) throw new Error("cannot acknowledge an unseen inbox item");
        const message = records.get(item.messageId);
        if (
          item.kind !== "resume" &&
          (!message || message.sourceInbox?.seq !== seq || message.content !== item.text)
        )
          throw new Error("cannot acknowledge an unrecorded user message");
      }
    store.append(this.id, request.messages);
    this.check(generation, signal, true);
    if (after !== undefined && after > this.#delivered) {
      store.acknowledge(this.id, after);
      this.check(generation, signal, true);
      this.#delivered = after;
    }
  }
  restoreDelivered(store: TranscriptStore): void {
    this.#delivered = store.state(this.id).inboxAfter;
  }

  ask(
    question: string,
    options: string[],
    allowText: boolean,
    timeoutMs: number,
    step?: string,
    generation = this.generation,
    signal?: AbortSignal,
  ): Promise<AskAnswer> {
    if (!generation) throw new SessionStoppedError();
    this.check(generation, signal);
    if (this.#ask) throw new Error("a question is already waiting for the user");
    const askId = ulid();
    const combined = AbortSignal.any([
      this.abort.signal,
      generation.signal,
      ...(signal ? [signal] : []),
    ]);
    const keys = options.map((_, i) => String.fromCharCode(65 + i));
    return new Promise<AskAnswer>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const aborted = () => finish({ by: "stop" });
      const finish = (answer: AskAnswer) => {
        if (settled) return false;
        settled = true;
        if (timer) clearTimeout(timer);
        combined.removeEventListener("abort", aborted);
        if (this.#ask?.askId === askId) this.#ask = undefined;
        try {
          this.append("ask.answer", { askId, ...answer }, step);
        } catch (error) {
          // Abort listeners cannot throw into the event loop or leave a tool waiting forever.
          reject(error);
          return false;
        }
        if (answer.by === "user") this.tainted = false;
        if (this.isCurrent(generation) && !this.#control) this.status = "running";
        resolve(answer);
        return true;
      };
      try {
        this.append(
          "ask.request",
          {
            askId,
            question,
            options: options.map((text, i) => ({ key: keys[i], text })),
            allowText,
          },
          step,
        );
        this.append("agent.state", { state: "waiting_user", reason: "question" });
      } catch (error) {
        reject(error);
        return;
      }
      this.#ask = { askId, options: keys, allowText, finish };
      this.status = "waiting_user";
      if (timeoutMs > 0) timer = setTimeout(() => finish({ by: "timeout" }), timeoutMs);
      combined.addEventListener("abort", aborted, { once: true });
      if (combined.aborted) aborted();
    });
  }
  answer(askId: string, option: string | undefined, text: string | undefined): boolean {
    const ask = this.#ask;
    if (!ask || ask.askId !== askId || this.stopped) return false;
    if (
      (option && !ask.options.includes(option)) ||
      (text && (!ask.allowText || text.length > 8000)) ||
      (!option && !text)
    )
      return false;
    return ask.finish({ ...(option ? { option } : {}), ...(text ? { text } : {}), by: "user" });
  }

  async takeover(
    reason: string,
    note: string,
    step?: string,
    lease?: ToolLease,
  ): Promise<TakeoverOutcome> {
    const generation = lease?.generation ?? this.generation;
    if (!generation) throw new SessionStoppedError();
    this.check(generation, lease?.signal);
    let resolve!: (outcome: TakeoverOutcome) => void;
    const released = new Promise<TakeoverOutcome>((r) => {
      resolve = r;
    });
    const record: ControlRecord = {
      requestId: ulid(),
      startedByGeneration: generation.id,
      held: false,
      released,
      resolve,
      step,
    };
    this.#control = record; // Synchronous admission fence, before abort/drain or any await.
    const draining: Promise<void>[] = [];
    for (const [other, call] of this.#active)
      if (other !== lease) {
        draining.push(call.settled);
        call.abort.abort(new ControlHeldError());
      }
    // This task belongs to the daemon, not to the caller's generation. A hung dependency keeps
    // the fence in place; neither a timeout nor a replacement grants premature desktop access.
    void Promise.all(draining)
      .then(() => {
        if (this.#control !== record || this.stopped) return;
        this.append("takeover.request", { requestId: record.requestId, reason, note }, step);
        record.held = true;
        this.status = "waiting_user";
        this.append("agent.state", { state: "waiting_user", reason: "takeover" });
      })
      .catch(() => {
        /* Keep the control fence if publication fails. Stop remains available. */
      });
    const signal = AbortSignal.any([
      this.abort.signal,
      generation.signal,
      ...(lease ? [lease.signal] : []),
    ]);
    return abortable(released, signal);
  }
  endTakeover(requestId: string, note: string | undefined): boolean {
    const record = this.#control;
    if (
      !record ||
      record.requestId !== requestId ||
      !record.held ||
      this.stopped ||
      (note?.length ?? 0) > 8000
    )
      return false;
    // Persist the user's hand-back note before waking any replacement brain.
    if (note) this.post("steer", note);
    this.append("takeover.end", { requestId, ...(note ? { note } : {}), by: "user" }, record.step);
    this.#control = undefined;
    this.tainted = false;
    this.status = "running";
    record.resolve({ ...(note ? { note } : {}), by: "user" });
    this.#wake();
    return true;
  }
  // Cleanup retains the live owner until calls actually settle, including after Stop. The kill
  // switch independently bounds its wait and freezes/stops the desktop if a dependency hangs.
  async toolsSettled(): Promise<void> {
    while (this.#active.size)
      await Promise.all([...this.#active.values()].map((call) => call.settled));
  }
  async waitForTools(signal?: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
    while (this.#active.size) {
      await abortable(
        Promise.all([...this.#active.values()].map((call) => call.settled)),
        combined,
      );
    }
    combined.throwIfAborted();
  }
  async waitForControl(signal?: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
    while (this.#control) await abortable(this.#control.released, combined);
    combined.throwIfAborted();
  }
  setStatus(status: SessionStatus): void {
    if (this.stopped) {
      this.status = "ended";
      return;
    }
    if (this.#control) {
      if (this.#control.held) this.status = "waiting_user";
      return;
    }
    this.status = status;
  }
  stop(): void {
    if (this.stopped) return;
    this.status = "ended";
    const generation = this.generation;
    if (generation) this.retireBrain(generation);
    this.abort.abort(new SessionStoppedError());
    const record = this.#control;
    if (record) {
      try {
        if (record.held)
          this.append("takeover.end", { requestId: record.requestId, by: "stop" }, record.step);
      } catch {
        // Stop and abort callbacks must still contain the desktop if the journal cannot write.
        console.error("agent takeover end could not be recorded");
      } finally {
        this.#control = undefined;
        record.resolve({ by: "stop" });
      }
    }
    this.#wake();
  }
  #changed(waitMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, waitMs));
      this.#waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  #wake(): void {
    for (const wake of [...this.#waiters]) wake();
  }
}
