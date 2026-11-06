import type { Dot3D } from "../../src/dot3d/dot3d.ts";
import { M } from "./cues.ts";
import { CREW, type Layout } from "./layout.ts";

// What dot does, at film seconds, each on a beat. Each input goes to the engine at its own time, never
// once a frame, so any frame comes out the same however the film is rendered.
export type Input = readonly [at: number, act: (dot: Dot3D) => void];

const look = (x: number, y: number) => (dot: Dot3D) => dot.pointerAt({ x, y });
const inOrder = (inputs: Input[]): readonly Input[] => inputs.sort((a, b) => a[0] - b[0]);

export const mainScript = ({ chatLook }: Layout): readonly Input[] =>
  inOrder([
    [0, (dot) => dot.setState("your-turn")],
    [0, look(0, 0)],
    [M.land, (dot) => dot.react("acknowledged")],
    [M.hop, (dot) => dot.react("success")],
    [M.perch + 0.5, look(...chatLook)],
    [M.hit - 0.5, look(0, 0)],
    [M.hit, (dot) => dot.react("success")],
    [M.hit + 0.5, look(4, 0)],
  ]);

// Each window's dot: awake as it pops in, then looking down at its work.
export const crewScript = (i: number): readonly Input[] => {
  const { pop } = CREW[i] as (typeof CREW)[number];
  return inOrder([
    [pop, (dot) => dot.setState("your-turn")],
    [pop + 0.5, look(0, 7)],
  ]);
};
