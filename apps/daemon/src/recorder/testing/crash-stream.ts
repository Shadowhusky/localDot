import { SYNTH_CODEC } from "@localdot/stage/testing";

export const CRASH_SYNTH = { widthMbs: 8, heightMbs: 8, keyEvery: 30 };
export const CRASH_FORMAT = { codec: SYNTH_CODEC, width: 128, height: 128 };
// 60 fps bursts of 45 frames with 700 ms of still screen between them, like Selkies' damage-driven
// stream, starting a second into the session.
export const crashArrival = (i: number): number =>
  1_000_000 + i * 16_667 + Math.floor(i / 45) * 700_000;
