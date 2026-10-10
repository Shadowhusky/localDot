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
