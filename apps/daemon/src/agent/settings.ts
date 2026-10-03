import { isAbsolute } from "node:path";
import { SECRET_ID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import { PrivateFiles } from "./private-files.ts";

export const RoleChoice = z.strictObject({
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/),
  key: z.string().regex(SECRET_ID_PATTERN).optional(),
  price: z
    .strictObject({
      inputUSDPerMTok: z.number().min(0).max(10_000),
      outputUSDPerMTok: z.number().min(0).max(10_000),
    })
    .refine(
      (p) => p.inputUSDPerMTok > 0 || p.outputUSDPerMTok > 0,
      "at least one remote price must be positive",
    )
    .optional(),
});
export type RoleChoice = z.infer<typeof RoleChoice>;
export const AgentSettings = z.strictObject({
  main: RoleChoice.optional(),
  fast: RoleChoice.optional(),
  local: RoleChoice.optional(),
  codexDenyRead: z
    .array(
      z
        .string()
        .min(1)
        .max(1024)
        .refine(
          (path) => path.isWellFormed() && isAbsolute(path) && !/[\0\r\n*?[\]]/.test(path),
          "Codex deny folders must be absolute literal paths",
        ),
    )
    .max(32)
    .optional(),
  taskBudgetUSD: z
    .number()
    .positive()
    .max(10_000)
    .refine((n) => Math.floor(n * 1e6 + 0.5) >= 1, "budget is below keyd's accounting precision")
    .optional(),
});
export type AgentSettings = z.infer<typeof AgentSettings>;
export class SettingsError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}
export class SettingsStore {
  readonly #files: PrivateFiles;
  constructor(home: string) {
    this.#files = new PrivateFiles(home);
  }
  get(): AgentSettings {
    try {
      const text = this.#files.text("agent.json", 64 * 1024);
      return text === undefined ? {} : AgentSettings.parse(JSON.parse(text));
    } catch {
      throw new SettingsError(409, "saved agent settings are invalid; review them before saving");
    }
  }
  put(settings: AgentSettings): AgentSettings {
    const parsed = AgentSettings.safeParse(settings);
    if (!parsed.success) throw new SettingsError(400, "invalid agent settings");
    this.#files.write("agent.json", `${JSON.stringify(parsed.data, null, 2)}\n`);
    return parsed.data;
  }
}
