import { z as schema } from "zod";

// Which browser dot's web browser runs. Chromium is in the released images; Google Chrome is added
// on this machine, from Google, once the user accepts Google's terms.
export const BrowserEngineName = schema.enum(["chrome", "chromium"]);
export type BrowserEngineName = schema.infer<typeof BrowserEngineName>;

export const BrowserEngineStatus = schema.strictObject({
  // What the next start of the web browser opens, and its version when it could be read.
  engine: BrowserEngineName,
  version: schema.string().max(32).optional(),
  // What the user chose; null until they have.
  choice: BrowserEngineName.nullable(),
  // Chrome can be added here. An older browser image can't take it.
  offered: schema.boolean(),
  // The browser image was built with Chrome in it, so there is nothing to choose.
  builtIn: schema.boolean(),
  installing: schema.boolean(),
  // A web browser is running on something else; it changes when it next restarts.
  restartNeeded: schema.boolean(),
  // Why Chrome isn't in use although it was chosen, or what last went wrong with it.
  problem: schema.string().max(400).optional(),
  problemAt: schema.iso.datetime().optional(),
  // The sign-ins as they were before Chrome first opened them, and the browser that last used them.
  backup: schema
    .strictObject({ at: schema.iso.datetime(), version: schema.string().max(32).optional() })
    .optional(),
});
export type BrowserEngineStatus = schema.infer<typeof BrowserEngineStatus>;

export const BrowserEngineRequest = schema.discriminatedUnion("choice", [
  schema.strictObject({
    choice: schema.literal("chrome"),
    acceptGoogleTerms: schema.literal(true),
    // Restart a running web browser as soon as Chrome is ready, rather than at its next start.
    restart: schema.boolean().optional(),
  }),
  schema.strictObject({ choice: schema.literal("chromium") }),
]);
export type BrowserEngineRequest = schema.infer<typeof BrowserEngineRequest>;

export const CHROME_TERMS_LINKS = {
  terms: "https://policies.google.com/terms",
  additional: "https://www.google.com/chrome/terms/",
} as const;
