import type { Point } from "./gaze.ts";

export type AttentionSource = "approval" | "pointer" | "target" | "cursor" | "changed" | "input";

export const ATTENTION_PRIORITY: readonly AttentionSource[] = [
  "approval",
  "pointer",
  "target",
  "cursor",
  "changed",
  "input",
];

export const ATTENTION_TTL_MS: Record<AttentionSource, number> = {
  approval: Number.POSITIVE_INFINITY,
  pointer: 2000,
  target: 2500,
  cursor: 1000,
  changed: 1200,
  input: 4000,
};

// The user sits in front of the screen, not at a point on it.
export type AttentionPoint = Point | "user";

export interface Attention {
  source: AttentionSource | "idle";
  point: AttentionPoint | null;
}

export class AttentionEngine {
  readonly #entries = new Map<AttentionSource, { point: AttentionPoint; at: number }>();

  set(source: AttentionSource, point: AttentionPoint, tMs: number): void {
    if (point !== "user" && !(Number.isFinite(point.x) && Number.isFinite(point.y))) return;
    this.#entries.set(source, { point, at: tMs });
  }

  clear(source: AttentionSource): void {
    this.#entries.delete(source);
  }

  resolve(tMs: number): Attention {
    for (const source of ATTENTION_PRIORITY) {
      const entry = this.#entries.get(source);
      if (entry && tMs - entry.at < ATTENTION_TTL_MS[source]) return { source, point: entry.point };
    }
    return { source: "idle", point: null };
  }
}
