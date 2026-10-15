import type { Dot3D } from "../dot3d/dot3d.ts";
import { CUES, M } from "./cues.ts";

// What dot does, at film seconds. Each input goes to the engine at its own time, never once a frame,
// so any frame comes out the same however the film is rendered.
export type Input = readonly [at: number, act: (dot: Dot3D) => void];

const look = (x: number, y: number) => (dot: Dot3D) => dot.pointerAt({ x, y });
// Toward its work: the Theatre is above and to the right of the dock.
const atWork = (dot: Dot3D) => dot.setFocus({ x: 7, y: -6 });

// The stage plays inputs in order, so each list is kept sorted by time; equal times keep their order.
const inOrder = (inputs: Input[]): readonly Input[] => inputs.sort((a, b) => a[0] - b[0]);

export const SCRIPT: readonly Input[] = inOrder([
  [0, (dot) => dot.setState("idle")],
  [M.land, (dot) => dot.react("acknowledged")],
  // Landed, dot turns to where its words will be before they come.
  [M.land + 0.2, (dot) => dot.setState("your-turn")],
  [M.land + 0.25, look(-6, 0)],
  [M.hello, (dot) => dot.say(1300)],
  [M.hello + 0.75, (dot) => dot.react("success")],
  [M.own, (dot) => dot.say(1900)],
  [M.screen, look(-5, 2)],
  [M.watch - 0.1, (dot) => dot.setState("watching")],
  [M.watch, atWork],
  [M.take, (dot) => dot.setState("your-turn")],
  [M.take + 0.3, look(4, -4)],
  [M.take + 0.9, look(6, -5)],
  [M.take + 1.5, look(3, -6)],
  [M.handBack, (dot) => dot.react("acknowledged")],
  [M.handBack + 0.2, (dot) => dot.setState("watching")],
  [M.handBack + 0.3, atWork],
  [M.models, (dot) => dot.setState("your-turn")],
  [M.models + 0.7, look(0, 0)],
  [M.jobs, (dot) => dot.react("success")],
  ...CUES.outfits.map(({ at }): Input => [at + 0.25, (dot) => dot.react("acknowledged")]),
  [M.lineup + 0.4, look(-3, 0)],
  [M.smile - 0.15, look(0, 0)],
  [M.smile, (dot) => dot.react("success")],
  [M.replay + 0.5, (dot) => dot.setState("watching")],
  [M.replay + 0.6, atWork],
  [M.saved, (dot) => dot.react("success")],
  [M.yours, (dot) => dot.setState("your-turn")],
  [M.yours + 0.5, look(-4, 0)],
  [M.pin, (dot) => dot.react("success")],
  [M.end + 0.6, look(4, 0)],
  [M.hit, (dot) => dot.react("success")],
]);

// What every dot in the line-up does, together: they face the camera and smile.
export const LINEUP_SCRIPT: readonly Input[] = inOrder([
  [M.lineup, (dot) => dot.setState("your-turn")],
  [M.smile - 0.15, look(0, 0)],
  [M.smile, (dot) => dot.react("success")],
]);
