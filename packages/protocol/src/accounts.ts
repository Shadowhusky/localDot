import { z } from "zod";

// A registrable domain or one of its hosts, as the web browser's cookies name them.
const SiteName = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u);

export const SignInSite = z.strictObject({
  site: SiteName,
  hosts: z.array(SiteName).min(1).max(64),
  cookies: z.number().int().positive(),
});
export type SignInSite = z.infer<typeof SignInSite>;

export const SignInSites = z.strictObject({ sites: z.array(SignInSite).max(5000) });
export type SignInSites = z.infer<typeof SignInSites>;

export const SignOutRequest = z.strictObject({ site: SiteName });
export type SignOutRequest = z.infer<typeof SignOutRequest>;
