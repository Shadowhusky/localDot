import { isAbsolute } from "node:path";
import { AgentRoleChoice, AgentSettingsDocument, currentAutonomy } from "@localdot/protocol";
import { z } from "zod";
import { PrivateFiles } from "./private-files.ts";

export const RoleChoice = AgentRoleChoice;
export type RoleChoice = z.infer<typeof RoleChoice>;
export const AgentSettings = AgentSettingsDocument.extend({
  codexDenyRead: z
    .array(
      AgentSettingsDocument.shape.codexDenyRead
        .unwrap()
        .element.refine(
          isAbsolute,
          "Codex deny folders must be absolute literal paths on this host",
        ),
    )
    .max(32)
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
      if (text === undefined) return {};
      const settings = AgentSettings.parse(JSON.parse(text));
      return settings.autonomy
        ? { ...settings, autonomy: currentAutonomy(settings.autonomy) }
        : settings;
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
