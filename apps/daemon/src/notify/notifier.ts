import {
  type AttentionChangeEvent,
  type AttentionItem,
  NOTIFY_COPY,
  type NotifyTestResult,
} from "@localdot/protocol";
import { type AttentionLedger, taskTitle } from "./attention.ts";
import type { MacNotifier } from "./mac.ts";
import { decide, type Notice, noticeOf } from "./policy.ts";
import type { PresenceBoard } from "./presence.ts";
import type { NotifyStore } from "./store.ts";
import type { WebPushSender } from "./webpush.ts";

// Approval cards are often revised a moment after they appear; only the one still waiting after
// this long is worth a ping.
export const SETTLE_MS = 1_500;
const REMEMBERED_KEYS = 512;

// A routine run's news: the routine.run app event (title: "<name>: <outcome>").
export interface RoutineRunNotice {
  type: "routine.run";
  routineId: string;
  runId: string;
  outcome:
    | "pending"
    | "running"
    | "done"
    | "needs_you"
    | "needs_you_expired"
    | "failed"
    | "skipped"
    | "missed"
    | "budget"
    | "stopped";
  sessionId: string | null;
  notify: boolean;
  title: string;
}

export const isRoutineRun = (event: { type: string }): event is RoutineRunNotice =>
  event.type === "routine.run";

export interface NotifierDeps {
  ledger: Pick<AttentionLedger, "subscribe" | "current" | "approvalExpiresAt" | "isRoutine">;
  store: Pick<NotifyStore, "settings">;
  mac: MacNotifier;
  push: Pick<WebPushSender, "sendAll">;
  presence: Pick<PresenceBoard, "snapshot" | "waitForShown">;
  publish(event: AttentionChangeEvent): void;
  // Where routine results come from. Without it a routine's session is announced like any other.
  routineRuns?(listener: (run: RoutineRunNotice) => void): () => void;
  now(): Date;
  timeZone(): string;
  settleMs?: number;
}

export class Notifier {
  readonly #delivered = new Set<string>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: NotifierDeps) {}

  start(): () => void {
    const routines = this.deps.routineRuns;
    const unrun = routines?.((run) => void this.notifyRoutine(run));
    const unsubscribe = this.deps.ledger.subscribe((item) => {
      this.deps.publish({ type: "attention.change", item, page: false });
      const notice = noticeOf(item);
      if (!notice) return;
      // A routine's own policy decides what its results say, through routine.run.
      if (
        notice.event !== "needs_you" &&
        routines &&
        this.deps.ledger.isRoutine(item.sessionId ?? "")
      )
        return;
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        if (this.deps.ledger.current(item.sessionId ?? "")?.key !== item.key) return;
        void this.deliver(notice, item);
      }, this.deps.settleMs ?? SETTLE_MS);
      this.#timers.add(timer);
    });
    return () => {
      unsubscribe();
      unrun?.();
      for (const timer of this.#timers) clearTimeout(timer);
      this.#timers.clear();
    };
  }

  async deliver(notice: Notice, item?: AttentionItem): Promise<void> {
    if (this.#delivered.has(notice.key)) return;
    this.#delivered.add(notice.key);
    if (this.#delivered.size > REMEMBERED_KEYS) {
      const oldest = this.#delivered.values().next().value;
      if (oldest !== undefined) this.#delivered.delete(oldest);
    }
    const delivery = decide(
      notice,
      this.deps.store.settings(),
      this.deps.presence.snapshot(),
      this.deps.now(),
      this.deps.timeZone(),
    );
    if (!delivery) return;
    // An approval's push lives as long as its card, between a minute and four hours.
    const until = item ? this.deps.ledger.approvalExpiresAt(item.sessionId ?? "") : undefined;
    if (until !== undefined)
      delivery.ttl = Math.min(
        4 * 60 * 60,
        Math.max(60, Math.ceil((until - this.deps.now().getTime()) / 1000)),
      );
    const work: Promise<unknown>[] = [];
    if (delivery.mac === "page" && item) {
      this.deps.publish({ type: "attention.change", item, page: true });
      // A hidden tab may be frozen by the browser: without its confirmation, show the banner.
      work.push(
        this.deps.presence.waitForShown(item.key).then((shown) => {
          if (!shown) return this.deps.mac.show(delivery.macTitle, delivery.macBody);
        }),
      );
    } else if (delivery.mac !== "none")
      work.push(this.deps.mac.show(delivery.macTitle, delivery.macBody));
    if (delivery.phone)
      work.push(
        this.deps.push.sendAll(delivery.payload, {
          ttl: delivery.ttl,
          urgency: delivery.urgency,
        }),
      );
    await Promise.allSettled(work);
  }

  // A routine's result, told as its own notify setting asks. The routine's session raises Needs you
  // itself (approval, question, take-over); only a question with no session ("Keep running …?")
  // comes from here.
  async notifyRoutine(run: RoutineRunNotice): Promise<void> {
    if (!run.notify || run.outcome === "pending" || run.outcome === "running") return;
    if (run.outcome === "needs_you" && run.sessionId) return;
    const needsYou = run.outcome === "needs_you";
    await this.deliver({
      key: `routine:${run.runId}:${run.outcome}`,
      event: needsYou ? "needs_you" : "routine",
      kind: needsYou ? "needs_you" : "routine",
      sessionId: run.sessionId,
      detail: taskTitle(run.title),
    });
  }

  // Send a test ignores the switches and quiet hours: it is how the user checks they work.
  async test(): Promise<NotifyTestResult> {
    const copy = NOTIFY_COPY.test;
    const [mac, phones] = await Promise.all([
      this.deps.mac.available
        ? this.deps.mac.show(copy.title, copy.body)
        : ("unavailable" as const),
      this.deps.push.sendAll({ kind: "test", sessionId: null }, { ttl: 60, urgency: "normal" }),
    ]);
    return { mac, phones };
  }
}
