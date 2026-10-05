// packages/stage/src/replay/clock.ts
export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

// The replay clock is closed-form: playback ms = anchor + elapsed wall ms × speed while playing.
export interface ReplayClock {
  playing: boolean;
  speed: ReplaySpeed;
  anchorWallMs: number;
  anchorPlayMs: number;
}

export function playMsAt(c: ReplayClock, wallMs: number): number {
  return c.playing ? c.anchorPlayMs + (wallMs - c.anchorWallMs) * c.speed : c.anchorPlayMs;
}

// Re-anchors at the current position, so a speed change or a pause never jumps.
export function retime(
  c: ReplayClock,
  wallMs: number,
  patch: Partial<Pick<ReplayClock, "playing" | "speed" | "anchorPlayMs">>,
): ReplayClock {
  const at = patch.anchorPlayMs ?? playMsAt(c, wallMs);
  return {
    playing: patch.playing ?? c.playing,
    speed: patch.speed ?? c.speed,
    anchorWallMs: wallMs,
    anchorPlayMs: at,
  };
}
