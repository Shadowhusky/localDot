import { z } from "zod";
import { Point, Rect } from "./geometry.ts";

export const TargetSource = z.enum(["ax", "dom", "som", "ocr", "vision", "coords"]);

export const Target = z.object({
  point: Point,
  bbox: Rect.optional(),
  source: TargetSource,
  role: z.string().max(64).optional(),
  name: z.string().max(64).optional(),
  app: z.string().max(128).optional(),
  window: z.string().max(256).optional(),
  url: z.string().max(2048).optional(),
  mark: z.number().int().nonnegative().optional(),
  secret: z.boolean().optional(),
});
export type Target = z.infer<typeof Target>;
