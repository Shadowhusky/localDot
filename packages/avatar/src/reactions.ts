export type ReactionKind = "nod" | "wince" | "cheer" | "hmph" | "surprise" | "blush";

export type ReactionOffsets = Partial<
  Record<"headX" | "headY" | "bodyX" | "brow" | "eyeOpen" | "blush", number>
>;

interface ReactionSpec {
  durationMs: number;
  offsets: ReactionOffsets;
  expressions: Record<string, number>;
}

export const REACTIONS: Record<ReactionKind, ReactionSpec> = {
  nod: { durationMs: 220, offsets: { headY: -0.15 }, expressions: {} },
  wince: { durationMs: 380, offsets: { brow: -0.6, eyeOpen: -0.4 }, expressions: {} },
  cheer: { durationMs: 700, offsets: { headY: 0.05 }, expressions: { smile: 1 } },
  hmph: { durationMs: 1100, offsets: { headX: 0.35, bodyX: 0.25 }, expressions: { annoyed: 1 } },
  surprise: { durationMs: 450, offsets: { brow: 0.8, eyeOpen: 0.15 }, expressions: {} },
  blush: { durationMs: 1600, offsets: { blush: 1 }, expressions: {} },
};

export const CHEER_COOLDOWN_MS = 5000;
const ATTACK_MS = 80;
const RELEASE_MS = 200;

export class ReactionMixer {
  #active: { kind: ReactionKind; start: number }[] = [];
  #lastCheer = Number.NEGATIVE_INFINITY;

  trigger(kind: ReactionKind, tMs: number): boolean {
    if (kind === "cheer") {
      if (tMs - this.#lastCheer < CHEER_COOLDOWN_MS) return false;
      this.#lastCheer = tMs;
    }
    this.#active.push({ kind, start: tMs });
    return true;
  }

  sample(tMs: number): { offsets: ReactionOffsets; expressions: Record<string, number> } {
    const offsets: ReactionOffsets = {};
    const expressions: Record<string, number> = {};
    this.#active = this.#active.filter((r) => tMs - r.start < REACTIONS[r.kind].durationMs);
    for (const r of this.#active) {
      const spec = REACTIONS[r.kind];
      const weight = envelope(tMs - r.start, spec.durationMs);
      for (const [key, value] of Object.entries(spec.offsets) as [
        keyof ReactionOffsets,
        number,
      ][]) {
        offsets[key] = (offsets[key] ?? 0) + value * weight;
      }
      for (const [name, value] of Object.entries(spec.expressions)) {
        expressions[name] = Math.max(expressions[name] ?? 0, value * weight);
      }
    }
    return { offsets, expressions };
  }
}

// Continuous even when a reaction is shorter than attack + release (a nod never jumps).
function envelope(elapsedMs: number, durationMs: number): number {
  return Math.max(0, Math.min(1, elapsedMs / ATTACK_MS, (durationMs - elapsedMs) / RELEASE_MS));
}
