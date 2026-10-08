import { z } from "zod";
import { Point } from "./geometry.ts";

export const MouseButton = z.enum(["left", "right", "middle"]);

export const Input = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    button: MouseButton,
    count: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    mods: z.array(z.string()).optional(),
    at: Point,
  }),
  z.object({ kind: z.literal("move"), to: Point }),
  z.object({ kind: z.literal("drag"), from: Point, to: Point, path: z.array(Point).optional() }),
  z.object({ kind: z.literal("scroll"), at: Point, dx: z.number(), dy: z.number() }),
  z.object({ kind: z.literal("type"), chars: z.number().int().nonnegative(), masked: z.boolean() }),
  // `repeat` presses the combo that many times; `holdMs` keeps it down that long, then releases.
  z.object({
    kind: z.literal("key"),
    combo: z.array(z.string()).min(1),
    repeat: z.number().int().min(2).max(100).optional(),
    holdMs: z.number().int().positive().max(30_000).optional(),
  }),
  z.object({ kind: z.literal("wait"), ms: z.number().int().nonnegative() }),
]);
export type Input = z.infer<typeof Input>;
export type InputKind = Input["kind"];
