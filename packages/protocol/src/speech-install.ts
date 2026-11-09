import { z as schema } from "zod";

// One-click speech on the computer running localDot: what it can install, how the install is going,
// and which speech model the voice route is using.
export const SpeechTierId = schema.enum(["light", "balanced", "languages"]);
export type SpeechTierId = schema.infer<typeof SpeechTierId>;

export const SpeechTierView = schema.strictObject({
  id: SpeechTierId,
  name: schema.string().max(32),
  // What it's good at, in plain words.
  summary: schema.string().max(200),
  // The model's and program's names and licences, which their licences ask to be kept in view.
  credit: schema.string().max(200),
  // Languages it hears, by two- or three-letter code; null when any language will do.
  languages: schema.array(schema.string().max(8)).max(64).nullable(),
  // Bytes fetched, including the speech program unless it's already here.
  downloadBytes: schema.number().int().nonnegative(),
  // Bytes it takes on disk once installed.
  diskBytes: schema.number().int().nonnegative(),
  // Peak memory while it turns speech into text; nothing while it isn't.
  memoryBytes: schema.number().int().nonnegative(),
  // How long a short message takes on this computer, in plain words.
  speed: schema.string().max(80),
  // Set when it would be slow or tight here. Heavier tiers stay available.
  warning: schema.string().max(200).optional(),
});
export type SpeechTierView = schema.infer<typeof SpeechTierView>;

export const SpeechInstallStage = schema.enum([
  "checking",
  "program",
  "model",
  "unpacking",
  "testing",
]);
export type SpeechInstallStage = schema.infer<typeof SpeechInstallStage>;

export const SpeechInstallProblem = schema.enum([
  "disk",
  "network",
  "stalled",
  "verify",
  "unpack",
  "cannot-run",
  "interrupted",
]);
export type SpeechInstallProblem = schema.infer<typeof SpeechInstallProblem>;

export const SpeechInstallJob = schema.strictObject({
  tier: SpeechTierId,
  state: schema.enum(["running", "failed"]),
  stage: SpeechInstallStage,
  // Bytes across the whole download, so one bar runs from start to finish.
  doneBytes: schema.number().int().nonnegative(),
  totalBytes: schema.number().int().nonnegative(),
  problem: SpeechInstallProblem.optional(),
  // The honest reason, in plain words, for every device to show alike.
  message: schema.string().max(400).optional(),
});
export type SpeechInstallJob = schema.infer<typeof SpeechInstallJob>;

export const SpeechInstallStatus = schema.strictObject({
  // This computer's system has a speech program to install.
  supported: schema.boolean(),
  host: schema.strictObject({
    // What to call the computer running localDot.
    computer: schema.enum(["Mac", "computer"]),
    memoryBytes: schema.number().int().nonnegative(),
    cpus: schema.number().int().nonnegative(),
    arch: schema.string().max(16),
  }),
  tiers: schema.array(SpeechTierView).max(8),
  recommended: SpeechTierId,
  installed: schema
    .strictObject({
      tier: SpeechTierId,
      name: schema.string().max(32),
      diskBytes: schema.number().int().nonnegative(),
      // The files no longer match what was installed, so they aren't run.
      damaged: schema.boolean(),
    })
    .nullable(),
  // A Whisper the person set up themselves. localDot only ever reads it.
  handInstalled: schema
    .strictObject({ model: schema.string().max(128), englishOnly: schema.boolean() })
    .nullable(),
  using: schema.enum(["installed", "hand-installed"]).nullable(),
  job: SpeechInstallJob.nullable(),
  freeBytes: schema.number().int().nonnegative(),
});
export type SpeechInstallStatus = schema.infer<typeof SpeechInstallStatus>;

export const SpeechInstallRequest = schema.strictObject({ tier: SpeechTierId });
export type SpeechInstallRequest = schema.infer<typeof SpeechInstallRequest>;
