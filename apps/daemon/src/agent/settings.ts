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
    let previous: AgentSettings = {};
    try {
      previous = this.get();
    } catch {
      /* Saving repairs invalid settings. */
    }
    const models = new Map<string, RoleChoice>();
    for (const doc of [previous, parsed.data]) {
      for (const choice of [...(doc.models ?? []), doc.main, doc.fast, doc.local]) {
        if (choice) models.set(JSON.stringify([choice.provider, choice.model, choice.key]), choice);
      }
    }
    const active = new Set(
      [parsed.data.main, parsed.data.fast, parsed.data.local]
        .filter((choice) => !!choice)
        .map((choice) => JSON.stringify([choice.provider, choice.model, choice.key])),
    );
    const remembered = [...models]
      .filter(([id]) => !active.has(id))
      .map(([, choice]) => choice)
      .slice(-100);
    const next = { ...parsed.data };
    if (remembered.length) next.models = remembered;
    else delete next.models;
    this.#files.write("agent.json", `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
