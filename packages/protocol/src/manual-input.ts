import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";
import { MouseButton } from "./input.ts";
import { boundedText } from "./text.ts";

const Point = z.strictObject({
  x: z.number().finite().nonnegative().max(16_384),
  y: z.number().finite().nonnegative().max(16_384),
});
const Mods = z
  .array(z.enum(["ctrl", "alt", "shift", "super"]))
  .max(4)
  .optional();
const Notches = z.number().int().min(-32).max(32);
const scrolls = (input: { dx: number; dy: number }) => input.dx !== 0 || input.dy !== 0;

const Click = z.strictObject({
  kind: z.literal("click"),
  at: Point,
  button: MouseButton,
  count: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  mods: Mods,
});
const Key = z.strictObject({
  kind: z.literal("key"),
  combo: z
    .array(z.string().regex(/^[A-Za-z0-9_+-]{1,32}$/))
    .min(1)
    .max(6),
});
const Text = z.strictObject({
  kind: z.literal("text"),
  text: boundedText(4000)
    .min(1)
    .refine((text) => text.isWellFormed() && !text.includes("\0")),
});
const scroll = { kind: z.literal("scroll"), at: Point, dx: Notches, dy: Notches };

// Only atomic commands: no pointer/key down state depends on a final client packet.
export const ManualInput = z.discriminatedUnion("kind", [
  Click,
  Key,
  z.strictObject(scroll).refine(scrolls),
  Text,
]);
export type ManualInput = z.infer<typeof ManualInput>;
export const TakeoverInputRequest = z.strictObject({
  requestId: z.string().regex(ULID_PATTERN),
  input: ManualInput,
});
export type TakeoverInputRequest = z.infer<typeof TakeoverInputRequest>;

// The user's direct control, one input per message in the order they made it. A button that a
// `down` pressed stays down only while the stream lasts: the daemon lets go of it when it ends.
export const ManualStreamInput = z.discriminatedUnion("kind", [
  Click,
  Key,
  z.strictObject({ ...scroll, mods: Mods }).refine(scrolls),
  Text,
  z.strictObject({ kind: z.literal("move"), at: Point }),
  z.strictObject({ kind: z.literal("down"), at: Point, button: MouseButton, mods: Mods }),
  z.strictObject({ kind: z.literal("up"), at: Point, button: MouseButton }),
]);
export type ManualStreamInput = z.infer<typeof ManualStreamInput>;
// The daemon's reply on the stream: how many of the inputs sent so far it has finished with.
export const ManualStreamAck = z.strictObject({ done: z.number().int().nonnegative() });
export type ManualStreamAck = z.infer<typeof ManualStreamAck>;
export const MANUAL_STREAM_CLOSE = {
  // Control ended or changed hands, or the computer changed: nothing more is accepted.
  changed: 4409,
  // An input may have reached the computer only in part: control stays fenced until Stop.
  uncertain: 4499,
  invalid: 4400,
} as const;
