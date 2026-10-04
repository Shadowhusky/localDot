import { z } from "zod";
import { SECRET_ID_PATTERN } from "./keyd.ts";
import { AutonomyPolicy } from "./safety.ts";

export const AgentModelPrice = z
  .strictObject({
    inputUSDPerMTok: z.number().min(0).max(10_000),
    outputUSDPerMTok: z.number().min(0).max(10_000),
  })
  .refine(
    (price) => price.inputUSDPerMTok > 0 || price.outputUSDPerMTok > 0,
    "at least one remote price must be positive",
  );
export const AgentRoleChoice = z.strictObject({
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/),
  key: z.string().regex(SECRET_ID_PATTERN).optional(),
  price: AgentModelPrice.optional(),
});
export type AgentRoleChoice = z.infer<typeof AgentRoleChoice>;
export const AgentDenyFolder = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      path.isWellFormed() &&
      !/[\0\r\n*?[\]]/.test(path) &&
      (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\")),
    "deny folders must be absolute literal paths",
  );
// The daemon additionally validates the path against its actual host's isAbsolute semantics.
export const AgentSettingsDocument = z.strictObject({
  autonomy: AutonomyPolicy.optional(),
  main: AgentRoleChoice.optional(),
  fast: AgentRoleChoice.optional(),
  local: AgentRoleChoice.optional(),
  codexDenyRead: z.array(AgentDenyFolder).max(32).optional(),
  taskBudgetUSD: z
    .number()
    .positive()
    .max(10_000)
    .refine((n) => Math.floor(n * 1e6 + 0.5) >= 1, "budget is below accounting precision")
    .optional(),
});
export type AgentSettingsDocument = z.infer<typeof AgentSettingsDocument>;
