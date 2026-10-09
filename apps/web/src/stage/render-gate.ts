import type { Camera, Scene } from "@localdot/stage";

// After a change the stage looks again on every display frame for this long, as a scene often
// moves on by itself shortly after an event; then a few times a second, so a still stage costs
// no rendering.
export const LINGER_MS = 2_000;
export const IDLE_LOOK_MS = 100;

const round = (_key: string, value: unknown) =>
  typeof value === "number" ? Math.round(value * 100) / 100 : value;

// What the stage draws, to a hundredth: two looks with one key paint the same picture. The scene's
// HUD is drawn by the page, not here.
export function sceneKey(
  scene: Scene | null,
  cam: Camera,
  screen: { w: number; h: number },
  fades: readonly number[],
): string {
  return JSON.stringify([scene && { ...scene, hud: undefined }, cam, screen, fades], round);
}

// Decides when the stage renders: only when what it would draw changed, a frame waits for its
// upload, or something else (a resize, the theme) asked for it.
export class RenderGate {
  #key: string | null = null;
  #dirty = true;
  #changedAt = Number.NEGATIVE_INFINITY;

  invalidate(): void {
    this.#dirty = true;
  }

  due(now: number, key: string, frame: boolean): boolean {
    if (!this.#dirty && !frame && key === this.#key) return false;
    this.#key = key;
    this.#dirty = false;
    this.#changedAt = now;
    return true;
  }

  // Milliseconds until the next look: 0 for the next display frame.
  wait(now: number): number {
    return now - this.#changedAt < LINGER_MS ? 0 : IDLE_LOOK_MS;
  }
}
