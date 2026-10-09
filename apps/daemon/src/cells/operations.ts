import {
  COMPUTER_OPERATION_STEPS,
  type ComputerOperation,
  type ComputerOperationKind,
  type ComputerOperationStep,
  EXPECTED_OPERATION_MS,
  type TimedOperationKind,
} from "@localdot/protocol";
import { type CellStore, MAX_TIMING_MS } from "./store.ts";
import type { CellState, StreamState } from "./types.ts";

// How long a viewer may still be connecting the screen of a computer that is ready.
export const SCREEN_MS = 60_000;

interface Operation {
  kind: ComputerOperationKind;
  step: ComputerOperationStep;
  startedAt: number;
  expectedMs: number;
  // Only a whole operation the user asked for says how long the next one will take.
  timed: boolean;
  // When the daemon's part ended: the computer is ready and the screen is still coming up.
  doneAt?: number;
}

export interface BeginOptions {
  startedAt?: number;
  timed?: boolean;
  // Added to the expected time, such as a restart's wait before it tries again.
  extraMs?: number;
}

interface LiveView {
  state: CellState;
  paused?: true;
  stream: StreamState;
}

const order = (step: ComputerOperationStep) => COMPUTER_OPERATION_STEPS.indexOf(step);
const timedKind = (kind: ComputerOperationKind): TimedOperationKind =>
  kind === "restart" ? "start" : kind;

// Each computer's current lifecycle operation, and how long its last ones took, so a page that
// loads in the middle of one carries on from the daemon's start.
export class CellOperations {
  readonly #running = new Map<string, Operation>();

  constructor(
    private readonly store: Pick<CellStore, "timings" | "saveTimings">,
    private readonly now: () => number = Date.now,
  ) {}

  // A second start while one is still going carries on with its clock.
  begin(
    id: string,
    kind: ComputerOperationKind,
    step: ComputerOperationStep,
    { startedAt, timed = kind !== "restart", extraMs = 0 }: BeginOptions = {},
  ): void {
    const current = this.#running.get(id);
    if (current?.kind === kind && current.doneAt === undefined) return;
    const timing = timedKind(kind);
    this.#running.set(id, {
      kind,
      step,
      startedAt: startedAt ?? this.now(),
      expectedMs: (this.store.timings(id)[timing] ?? EXPECTED_OPERATION_MS[timing]) + extraMs,
      timed,
    });
  }

  // Whether a lifecycle operation is going on, before its step or end is reported.
  running(id: string): boolean {
    const op = this.#running.get(id);
    return !!op && op.doneAt === undefined;
  }

  // Steps only go forward, so no page's progress ever goes back. True when it moved.
  step(id: string, step: ComputerOperationStep): boolean {
    const op = this.#running.get(id);
    if (!op || op.doneAt !== undefined || order(step) <= order(op.step)) return false;
    op.step = step;
    return true;
  }

  // The daemon's part succeeded. A timed operation is remembered as the next one's expected time;
  // a start then waits for the screen.
  finish(id: string): void {
    this.#done(id, true);
  }

  // Ready by some other way than the operation's own end, so its length says nothing.
  settle(id: string): void {
    this.#done(id, false);
  }

  // The screen is up: the start is over for every page.
  connected(id: string): void {
    if (this.#running.get(id)?.doneAt !== undefined) this.#running.delete(id);
  }

  end(id: string): void {
    this.#running.delete(id);
  }

  summary(id: string, live: LiveView): ComputerOperation | undefined {
    const op = this.#running.get(id);
    if (!op) return undefined;
    const now = this.now();
    if (op.doneAt === undefined) {
      if (live.state !== "starting" && live.state !== "stopping") return undefined;
    } else if (now - op.doneAt > SCREEN_MS) {
      this.#running.delete(id);
      return undefined;
    } else if (live.state !== "ready" || live.paused || live.stream.connection === "live")
      return undefined;
    return {
      kind: op.kind,
      step: op.step,
      startedAt: op.startedAt,
      elapsedMs: Math.max(0, now - op.startedAt),
      expectedMs: op.expectedMs,
    };
  }

  #done(id: string, remember: boolean): void {
    const op = this.#running.get(id);
    if (!op || op.doneAt !== undefined) return;
    const now = this.now();
    if (remember && op.timed) this.#remember(id, op.kind, now - op.startedAt);
    if (op.kind === "stop") {
      this.#running.delete(id);
      return;
    }
    op.step = "screen";
    op.doneAt = now;
  }

  #remember(id: string, kind: ComputerOperationKind, ms: number): void {
    const timing = timedKind(kind);
    try {
      this.store.saveTimings(id, {
        ...this.store.timings(id),
        [timing]: Math.min(MAX_TIMING_MS, Math.max(1, Math.round(ms))),
      });
    } catch (err) {
      console.error(
        `cell ${id}: how long it took was not kept (${(err as NodeJS.ErrnoException).code ?? "no error code"})`,
      );
    }
  }
}
