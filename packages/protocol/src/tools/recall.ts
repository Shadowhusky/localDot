import { z } from "zod";

export const RECALL_DEFAULT_LIMIT = 5;
export const RecallInput = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(8).optional(),
});
export type RecallInput = z.infer<typeof RecallInput>;
