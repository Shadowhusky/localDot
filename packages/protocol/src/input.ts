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
  // With `durationMs`, the cursor glides there from where it is instead of jumping.
  z.object({
    kind: z.literal("move"),
    to: Point,
    durationMs: z.number().int().positive().max(10_000).optional(),
  }),
  // Press at `from`, follow `path` (its points between the two ends) in `durationMs`, release at
  // `to`; `mods` stay down the whole time.
  z.object({
    kind: z.literal("drag"),
    from: Point,
    to: Point,
    path: z.array(Point).max(62).optional(),
    button: MouseButton,
    mods: z.array(z.string()).max(4).optional(),
    durationMs: z.number().int().positive().max(10_000),
  }),
  // A button (with `mods`) that stays down until its `up`.
  z.object({
    kind: z.literal("down"),
    button: MouseButton,
    at: Point,
    mods: z.array(z.string()).max(4).optional(),
  }),
  z.object({ kind: z.literal("up"), button: MouseButton, at: Point }),
  z.object({
    kind: z.literal("scroll"),
    at: Point,
    dx: z.number(),
    dy: z.number(),
    mods: z.array(z.string()).max(4).optional(),
  }),
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
