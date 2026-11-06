import { z } from "zod";

// Private daemon-to-browser input. Never exposed as a model tool or a text/progress stream.
export const BrowserSecretRequest = z.strictObject({
  origin: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && url.origin === value;
      } catch {
        return false;
      }
    }),
  at: z.strictObject({
    x: z.number().finite().min(0).lt(1280),
    y: z.number().finite().min(0).lt(800),
  }),
  purpose: z.literal("device_code").optional(),
  node: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  username: z
    .string()
    .min(1)
    .max(2000)
    .refine((value) => value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value))
    .optional(),
  text: z
    .string()
    .min(1)
    .max(1000)
    .refine((value) => value.isWellFormed() && !/[\p{Cc}\p{Cf}]/u.test(value))
    .optional(),
});
export type BrowserSecretRequest = z.infer<typeof BrowserSecretRequest>;
export const BrowserSecretReply = z.strictObject({
  filled: z.boolean(),
  rememberable: z.boolean(),
  submitted: z.boolean().optional(),
});
export type BrowserSecretReply = z.infer<typeof BrowserSecretReply>;

// Where a saved login would go on the page the user sees, for the user's own tap while they hold
// the browser. It says nothing of what the page holds; `field` is asked for only when it is needed.
export const BrowserSignInPageRequest = z.strictObject({ fields: z.boolean() });
export const BrowserSignInPage = z.strictObject({
  tabId: z.string().max(128),
  origin: z.string().max(2048).nullable(),
  field: z
    .strictObject({
      kind: z.enum(["password", "account"]),
      at: BrowserSecretRequest.shape.at,
    })
    .optional(),
});
export type BrowserSignInPage = z.infer<typeof BrowserSignInPage>;
