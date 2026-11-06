import { z } from "zod";
import { BrowserSignInMode } from "./browser-control.ts";
import { ULID_PATTERN } from "./ids.ts";

export const UserBrowserSignInRequest = z.strictObject({
  requestId: z.string().regex(ULID_PATTERN),
  action: z.enum(["status", "start", "fill", "fill-password"]),
});
// What the page the user holds asks of them. No password, and no address beyond a saved login's site.
export const UserBrowserSignInPage = z.strictObject({
  // Its site turns away a browser under agent control, so sign-in mode comes first.
  ownBrowser: z.literal(true).optional(),
  saved: z.strictObject({ site: z.string().max(2048), username: z.string().max(2000) }).optional(),
});
export type UserBrowserSignInPage = z.infer<typeof UserBrowserSignInPage>;
export const UserBrowserFill = z.enum([
  "submitted",
  "filled",
  "account",
  "no-field",
  "form",
  "locked",
  "refused",
]);
export type UserBrowserFill = z.infer<typeof UserBrowserFill>;
export const UserBrowserSignInReply = z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(false) }),
  z.strictObject({
    available: z.literal(true),
    mode: BrowserSignInMode,
    changing: z.boolean(),
    page: UserBrowserSignInPage.optional(),
    fill: UserBrowserFill.optional(),
  }),
]);
