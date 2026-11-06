import { z } from "zod";
import { Sealed } from "./keyd.ts";

const CONTROL = /[\p{Cc}\p{Cf}]/u;
const MAX_PASSWORD = 1000;
const MAX_ACCOUNT = 2000;
export const MAX_EXPORT_BYTES = 4 * 1024 * 1024;

export const LoginOrigin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch {
      return false;
    }
  });

// What Settings shows of a saved login. `confirm`: a task fills it only after the user's tap.
export const SavedLogin = z.strictObject({
  origin: LoginOrigin,
  username: z.string().max(MAX_ACCOUNT),
  confirm: z.boolean().optional(),
});
export type SavedLogin = z.infer<typeof SavedLogin>;
export const SavedLogins = z.strictObject({ logins: z.array(SavedLogin).max(3000) });

// Sealed to keyd in the page, so the daemon relays only ciphertext.
export const SealedLogin = z.strictObject({ sealed: Sealed });

export const LoginImportSkip = z.strictObject({
  reason: z.string().max(32),
  count: z.number().int().nonnegative(),
  lines: z.array(z.number().int().nonnegative()).max(20),
});
export type LoginImportSkip = z.infer<typeof LoginImportSkip>;
export const LoginImport = z.strictObject({
  rows: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  alreadySaved: z.number().int().nonnegative(),
  skipped: z.array(LoginImportSkip).max(32),
});
export type LoginImport = z.infer<typeof LoginImport>;

// Why a password can't be saved to be typed into a page, as the browser's private input path has it.
export function passwordProblem(password: string): string | undefined {
  if (!password) return "Enter the password.";
  if (password.length > MAX_PASSWORD) return `Keep it under ${MAX_PASSWORD} characters.`;
  if (!password.isWellFormed() || CONTROL.test(password))
    return "It has characters that can't be typed into a page.";
  return undefined;
}

export function accountProblem(account: string): string | undefined {
  if (account.length > MAX_ACCOUNT) return `Keep it under ${MAX_ACCOUNT} characters.`;
  if (!account.isWellFormed() || CONTROL.test(account))
    return "It has characters that can't be typed into a page.";
  return undefined;
}
