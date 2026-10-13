import { z } from "zod";
import { SECRET_ID_PATTERN } from "./keyd.ts";
import { ModelOptions } from "./model-options.ts";
import { PurposeCheck } from "./purpose.ts";
import { ResearchBudget } from "./research.ts";
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
  options: ModelOptions.optional(),
  // What a custom endpoint's model can do, as the user states it; the daemon refuses these for any
  // other provider. Without them the model sees images and has a 32,768-token context.
  vision: z.boolean().optional(),
  contextTokens: z.number().int().min(4_096).max(2_000_000).optional(),
  // A custom endpoint on a flat-rate plan: no per-token price, on a route keyd marks flat.
  plan: z.literal(true).optional(),
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
const BudgetUSD = z
  .number()
  .positive()
  .max(10_000)
  .refine((n) => Math.floor(n * 1e6 + 0.5) >= 1, "budget is below accounting precision");
// When dot checks in with the user, each off until they turn it on: after this many steps, after
// this many failed actions in a row, and a hard stop after this many actions, enforced outside dot.
// The user's next message starts every count again.
export const CheckIns = z.strictObject({
  steps: z.number().int().min(5).max(10_000).optional(),
  failures: z.number().int().min(2).max(100).optional(),
  actions: z.number().int().min(10).max(100_000).optional(),
});
export type CheckIns = z.infer<typeof CheckIns>;
// The daemon additionally validates the path against its actual host's isAbsolute semantics.
export const AgentSettingsDocument = z.strictObject({
  autonomy: AutonomyPolicy.optional(),
  main: AgentRoleChoice.optional(),
  fast: AgentRoleChoice.optional(),
  local: AgentRoleChoice.optional(),
  // Previously configured models remain available when the active provider changes.
  models: z.array(AgentRoleChoice).max(100).optional(),
  permissionMode: z.enum(["custom", "auto", "full"]).optional(),
  codexDenyRead: z.array(AgentDenyFolder).max(32).optional(),
  // Spending limits are the user's to set; without one dot never stops for cost.
  taskBudgetUSD: BudgetUSD.optional(),
  dayBudgetUSD: BudgetUSD.optional(),
  checkIns: CheckIns.optional(),
  // Auto when absent.
  purposeCheck: PurposeCheck.optional(),
  // On when absent: each task starts knowing the user's last few tasks.
  recentActivity: z.enum(["on", "off"]).optional(),
  // How far a research task reads before it writes; DEFAULT_RESEARCH_BUDGET when absent.
  research: ResearchBudget.optional(),
});
export type AgentSettingsDocument = z.infer<typeof AgentSettingsDocument>;
