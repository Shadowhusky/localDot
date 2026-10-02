import { LaunchApp, MouseButton } from "@localdot/protocol";
import { z } from "zod";

const coord = (max: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(max - 1);
const Speed = z.enum(["auto", "watch", "fast", "instant"]);
const label = z.string().min(1).max(80).optional();

export const PuppetStep = z.discriminatedUnion("do", [
  z.object({
    do: z.literal("launch"),
    app: LaunchApp,
    args: z.array(z.string().max(2048)).max(16).optional(),
    waitMs: z.number().int().nonnegative().max(60_000).optional(),
    label,
  }),
  z
    .object({
      do: z.literal("click"),
      x: coord(1280).optional(),
      y: coord(800).optional(),
      find: z
        .object({
          name: z.string().min(1).max(256),
          role: z.string().max(64).optional(),
          app: z.string().max(128).optional(),
        })
        .optional(),
      button: MouseButton.optional(),
      count: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      speed: Speed.optional(),
      label,
    })
    .refine((s) => (s.x !== undefined && s.y !== undefined) || s.find !== undefined, {
      message: "click needs a point or find",
    }),
  z.object({
    do: z.literal("type"),
    text: z.string().min(1).max(2000),
    masked: z.boolean().optional(),
    speed: Speed.optional(),
    label,
  }),
  z.object({
    do: z.literal("key"),
    combo: z.array(z.string().min(1).max(32)).min(1).max(4),
    speed: Speed.optional(),
    label,
  }),
  z.object({
    do: z.literal("scroll"),
    x: coord(1280),
    y: coord(800),
    dx: z.number().int().min(-50).max(50),
    dy: z.number().int().min(-50).max(50),
    speed: Speed.optional(),
    label,
  }),
  z.object({ do: z.literal("wait"), ms: z.number().int().nonnegative().max(60_000), label }),
]);
export type PuppetStep = z.infer<typeof PuppetStep>;

export const PuppetScript = z.object({
  v: z.literal(1),
  title: z.string().min(1).max(200),
  steps: z.array(PuppetStep).min(1).max(200),
});
export type PuppetScript = z.infer<typeof PuppetScript>;

export function parsePuppetScript(value: unknown): PuppetScript {
  return PuppetScript.parse(value);
}
