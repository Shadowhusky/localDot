import type { EventOf } from "@localdot/protocol";

export type AgentStateName = EventOf<"agent.state">["data"]["state"];

export interface Pose {
  brow: number;
  eyeOpen: number;
  headY: number;
  bodyX: number;
  eyeBiasX: number;
  eyeBiasY: number;
  expressions: Record<string, number>;
}

const BASE: Pose = {
  brow: 0,
  eyeOpen: 1,
  headY: 0,
  bodyX: 0,
  eyeBiasX: 0,
  eyeBiasY: 0,
  expressions: {},
};

export const STATE_POSES: Record<AgentStateName, Pose> = {
  idle: BASE,
  thinking: { ...BASE, eyeBiasX: -0.4, eyeBiasY: 0.5, headY: 0.05 },
  acting: { ...BASE, headY: -0.05, bodyX: 0.05, brow: 0.1 },
  observing: { ...BASE, brow: 0.05 },
  waiting_user: { ...BASE, brow: 0.5, headY: 0.05 },
  paused: { ...BASE, eyeOpen: 0.9 },
  error: { ...BASE, brow: -0.4, eyeOpen: 0.8, expressions: { worried: 0.6 } },
  done: { ...BASE, expressions: { smug: 0.7 } },
};

export const MIN_HOLD_MS = 250;
export const THINKING_HMM_MS = 5000;

export class StateGate {
  #current: AgentStateName;
  #since: number;
  #pending: AgentStateName | null = null;
  #pendingAt = 0;

  constructor(initial: AgentStateName = "idle", t0 = Number.NEGATIVE_INFINITY) {
    this.#current = initial;
    this.#since = t0;
  }

  request(state: AgentStateName, tMs: number): void {
    this.#settle(tMs);
    if (state === this.#current) {
      this.#pending = null;
      return;
    }
    this.#pending = state;
    this.#pendingAt = tMs;
    this.#settle(tMs);
  }

  current(tMs: number): AgentStateName {
    this.#settle(tMs);
    return this.#current;
  }

  heldFor(tMs: number): number {
    this.#settle(tMs);
    return tMs - this.#since;
  }

  #settle(tMs: number): void {
    if (this.#pending === null) return;
    const allowedAt = Math.max(this.#pendingAt, this.#since + MIN_HOLD_MS);
    if (tMs < allowedAt) return;
    this.#current = this.#pending;
    this.#since = allowedAt;
    this.#pending = null;
  }
}
