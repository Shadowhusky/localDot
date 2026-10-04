import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";
import { MouseButton } from "./input.ts";
import { boundedText } from "./text.ts";

const Point = z.strictObject({
  x: z.number().finite().nonnegative().max(16_384),
  y: z.number().finite().nonnegative().max(16_384),
});
const Modifier = z.enum(["ctrl", "alt", "shift", "super"]);
// Only atomic commands: no pointer/key down state depends on a final client packet.
export const ManualInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("click"),
    at: Point,
    button: MouseButton,
    count: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    mods: z.array(Modifier).max(4).optional(),
  }),
  z.strictObject({
    kind: z.literal("key"),
    combo: z
      .array(z.string().regex(/^[A-Za-z0-9_+-]{1,32}$/))
      .min(1)
      .max(6),
  }),
  z
    .strictObject({
      kind: z.literal("scroll"),
      at: Point,
      dx: z.number().int().min(-32).max(32),
      dy: z.number().int().min(-32).max(32),
    })
    .refine((input) => input.dx !== 0 || input.dy !== 0),
  z.strictObject({
    kind: z.literal("text"),
    text: boundedText(4000)
      .min(1)
      .refine((text) => text.isWellFormed() && !text.includes("\0")),
  }),
]);
export type ManualInput = z.infer<typeof ManualInput>;
export const TakeoverInputRequest = z.strictObject({
  requestId: z.string().regex(ULID_PATTERN),
  input: ManualInput,
});
export type TakeoverInputRequest = z.infer<typeof TakeoverInputRequest>;
