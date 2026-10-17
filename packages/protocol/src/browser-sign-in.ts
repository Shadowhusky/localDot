import { z } from "zod";
import { BrowserSignInMode } from "./browser-control.ts";
import { ULID_PATTERN } from "./ids.ts";

export const UserBrowserSignInRequest = z.strictObject({
  requestId: z.string().regex(ULID_PATTERN),
  action: z.enum(["status", "start"]),
});
export const UserBrowserSignInReply = z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(false) }),
  z.strictObject({ available: z.literal(true), mode: BrowserSignInMode, changing: z.boolean() }),
]);
