import {
  PlanProvider,
  PlanUsage,
  type PlanUsageReply,
  type PlanUsageWindow,
  SubscriptionUsageData,
} from "@localdot/protocol";
import { z } from "zod";
import { PrivateFiles } from "./private-files.ts";

const FILE = "plan-usage.json";
const MAX_BYTES = 16 * 1024;
// A reading this recent is not read again when the menu opens.
const FRESH_MS = 2 * 60_000;
// One read per plan at a time, and at most this often, whether it worked or not.
const RETRY_MS = 60_000;
const READ_TIMEOUT_MS = 20_000;

const Stored = z.object({ plans: z.array(z.unknown()).max(8) });

// What a plan's own app said about its usage, or that nobody is signed in to it any more.
export type PlanReading =
  | { usage: SubscriptionUsageData; observedAt: number }
  | "signed_out"
  | undefined;
export type PlanRead = (signal: AbortSignal) => Promise<PlanReading>;

export interface PlanUsageDeps {
  home: string;
  // Reads a plan's usage from its own app without a model turn, where the app offers one.
  read?: Partial<Record<PlanProvider, PlanRead>>;
  now?: () => number;
}

// The oldest reading the plan's figures rest on: its windows', or the plan's when it has none.
const readAt = (plan: PlanUsage) =>
  plan.windows.length
    ? Math.min(...plan.windows.map((window) => window.observedAt))
    : plan.observedAt;
// A task reports only the window it last touched, so a plan without both is never fresh.
const complete = (plan: PlanUsage) => plan.windows.length >= 2;

// The latest usage each subscription plan reported, from any task or from the plan's own app.
// A reading replaces only the windows it carries and nothing read after it.
export class PlanUsageStore {
  readonly #files: PrivateFiles;
  readonly #read: Partial<Record<PlanProvider, PlanRead>>;
  readonly #now: () => number;
  readonly #plans = new Map<PlanProvider, PlanUsage>();
  readonly #flights = new Map<PlanProvider, Promise<void>>();
  readonly #attempts = new Map<PlanProvider, number>();
  readonly #closing = new AbortController();
  constructor(deps: PlanUsageDeps) {
    this.#files = new PrivateFiles(deps.home);
    this.#read = deps.read ?? {};
    this.#now = deps.now ?? Date.now;
    for (const plan of this.#load()) this.#plans.set(plan.provider, plan);
  }
  list(): PlanUsage[] {
    return [...this.#plans.values()].map((plan) => structuredClone(plan));
  }
  reply(): PlanUsageReply {
    return { plans: this.list(), checking: [...this.#flights.keys()] };
  }
  record(value: unknown, observedAt: number): void {
    const parsed = SubscriptionUsageData.safeParse(value);
    if (!parsed.success || !Number.isFinite(observedAt) || observedAt < 0) return;
    const usage = parsed.data;
    const at = Math.min(Math.round(observedAt), this.#now());
    const before = this.#plans.get(usage.provider);
    const newer = !before || before.observedAt <= at;
    const samePlan = !before || !usage.plan || !before.plan || usage.plan === before.plan;
    if (!samePlan && !newer) return;
    const windows = new Map<string, PlanUsageWindow>(
      samePlan ? before?.windows.map((window) => [window.window, window]) : [],
    );
    for (const window of usage.windows) {
      const held = windows.get(window.window);
      if (!held || held.observedAt <= at) windows.set(window.window, { ...window, observedAt: at });
    }
    const latest = newer ? usage : before;
    const plan = (newer ? usage.plan : undefined) ?? before?.plan ?? usage.plan;
    const next = PlanUsage.safeParse({
      provider: usage.provider,
      ...(plan ? { plan } : {}),
      windows: [...windows.values()].sort((a, b) => a.window.localeCompare(b.window)),
      limitReached: latest.limitReached,
      ...(latest.limitReached && latest.limitResetsAt !== undefined
        ? { limitResetsAt: latest.limitResetsAt }
        : {}),
      observedAt: Math.max(before?.observedAt ?? 0, at),
    });
    if (!next.success || JSON.stringify(next.data) === JSON.stringify(before)) return;
    this.#plans.set(usage.provider, next.data);
    this.#save();
  }
  // Nobody is signed in to the plan now: what it said belonged to whoever was.
  forget(provider: PlanProvider): void {
    if (this.#plans.delete(provider)) this.#save();
  }
  // Reads each plan whose figures are not fresh from its own app, in the background. Settles once
  // the reads it started have.
  refresh(): Promise<void> {
    const started: Promise<void>[] = [];
    for (const provider of PlanProvider.options) {
      const read = this.#read[provider];
      if (!read || this.#flights.has(provider) || this.#closing.signal.aborted) continue;
      const now = this.#now();
      const plan = this.#plans.get(provider);
      if (plan && complete(plan) && now - readAt(plan) < FRESH_MS) continue;
      if (now - (this.#attempts.get(provider) ?? Number.NEGATIVE_INFINITY) < RETRY_MS) continue;
      this.#attempts.set(provider, now);
      const signal = AbortSignal.any([this.#closing.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
      const flight = read(signal)
        .then(
          (reading) => {
            if (this.#closing.signal.aborted) return;
            if (reading === "signed_out") this.forget(provider);
            else if (reading) this.record(reading.usage, reading.observedAt);
          },
          () => {},
        )
        .finally(() => this.#flights.delete(provider));
      this.#flights.set(provider, flight);
      started.push(flight);
    }
    return Promise.all(started).then(() => {});
  }
  close(): void {
    this.#closing.abort();
  }
  #load(): PlanUsage[] {
    try {
      const text = this.#files.text(FILE, MAX_BYTES);
      if (text === undefined) return [];
      const stored = Stored.safeParse(JSON.parse(text));
      if (!stored.success) return [];
      const now = this.#now();
      return stored.data.plans.flatMap((value) => {
        const plan = PlanUsage.safeParse(value);
        // A reading from the future came from a clock that has since been set back.
        return plan.success &&
          [plan.data, ...plan.data.windows].every((reading) => reading.observedAt <= now)
          ? [plan.data]
          : [];
      });
    } catch {
      return [];
    }
  }
  #save(): void {
    try {
      this.#files.write(FILE, `${JSON.stringify({ plans: this.list() })}\n`);
    } catch {
      console.error("plan usage could not be saved");
    }
  }
}
