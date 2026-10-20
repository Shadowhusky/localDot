import { z } from "zod";

// Claude Code's model names and aliases, such as "sonnet" or "claude-sonnet-5-5".
export const CLAUDE_CODE_MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const CLAUDE_CODE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
export const CLAUDE_CODE_SIGN_IN = "claude auth login";
export const CLAUDE_CODE_UPDATE = "claude update";
// Claude Code's own model aliases, offered by every version.
export const CLAUDE_CODE_MODELS: readonly { readonly id: string; readonly name: string }[] =
  Object.freeze([
    { id: "sonnet", name: "Claude Sonnet" },
    { id: "opus", name: "Claude Opus" },
  ]);

const line = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s));

// What localDot learns from the user's own Claude Code through its status command: never its
// sign-in, its account's address or its organisation.
export const ClaudeCodeStatus = z
  .strictObject({
    state: z.enum(["not_installed", "outdated", "signed_out", "signed_in", "unavailable"]),
    version: z
      .string()
      .regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/)
      .optional(),
    plan: z
      .string()
      .regex(/^[a-z0-9_-]{1,32}$/)
      .optional(),
    reason: line(300).optional(),
    command: line(200).optional(),
    models: z
      .array(
        z.strictObject({
          id: z.string().regex(CLAUDE_CODE_MODEL),
          name: line(128).min(1),
          resolvedModel: z.string().regex(CLAUDE_CODE_MODEL).optional(),
          efforts: z
            .array(z.enum(["low", "medium", "high", "xhigh", "max"]))
            .max(5)
            .optional(),
          fast: z.boolean().optional(),
        }),
      )
      .max(32)
      .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length),
    checkedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine((status) => status.state !== "signed_in" || status.models.length > 0);
export type ClaudeCodeStatus = z.infer<typeof ClaudeCodeStatus>;
