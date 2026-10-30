import { z } from "zod";
import { SECRET_ID_PATTERN } from "./keyd.ts";
import { ModelOptions } from "./model-options.ts";
import { Accessory, PersonaId } from "./personas.ts";
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
  // A custom endpoint that takes OpenAI's service_tier, so its models offer Fast and Ultrafast.
  speedTiers: z.literal(true).optional(),
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
// Another localDot the user runs, which the switcher opens at its own address.
export const LocalDotLink = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((name) => !/[\p{Cc}<>]/u.test(name), "Use letters, numbers and punctuation"),
  url: z
    .string()
    .max(512)
    .refine((url) => {
      try {
        const parsed = new URL(url);
        return /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password;
      } catch {
        return false;
      }
    }, "An http or https address"),
});
export type LocalDotLink = z.infer<typeof LocalDotLink>;

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
  // Which dot works the next task; the everyday dot when absent.
  persona: PersonaId.optional(),
  // Auto: each new conversation's dot is picked from its first message, `persona` when no pick
  // comes in time. Off when absent.
  autoPersona: z.literal(true).optional(),
  // This localDot, as the user tells it apart from their others.
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((name) => !/[\p{Cc}<>]/u.test(name), "Use letters, numbers and punctuation")
    .optional(),
  accessory: Accessory.optional(),
  localDots: z.array(LocalDotLink).max(12).optional(),
});
export type AgentSettingsDocument = z.infer<typeof AgentSettingsDocument>;
