import { ComputerFence, ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import type { CellSummary } from "./types.ts";
export const CellSummarySchema = z.strictObject({
  id: z.string().regex(ULID_PATTERN),
  state: z.enum(["starting", "ready", "stopping", "stopped", "failed", "removed"]),
  scale: z.union([z.literal(1), z.literal(2)]),
  createdAt: z.string().max(64),
  stream: z.strictObject({
    connection: z.enum(["none", "connecting", "live", "stalled", "disconnected"]),
    viewers: z.number().int().nonnegative(),
    lastUpstreamAt: z.number().nonnegative().nullable(),
  }),
  error: z.string().max(2048).optional(),
  paused: z.literal(true).optional(),
  fenced: ComputerFence.optional(),
  replacementPending: z.literal(true).optional(),
  updateAvailable: z.literal(true).optional(),
  updating: z.literal(true).optional(),
  needsFreshStart: z.literal(true).optional(),
});
export function parseCells(value: unknown): CellSummary[] {
  const rows = z.array(CellSummarySchema).max(1024).parse(value);
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error("Duplicate computer identity");
  return rows;
}
export function parseCell(value: unknown, id?: string): CellSummary {
  const row = CellSummarySchema.parse(value);
  if (id && row.id !== id) throw new Error("Computer owner changed");
  return row;
}
